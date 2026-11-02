// Milestone 27: Voronoi fracture with a constraint network (fracture.mjs), its solver side (physics.mjs) and the
// splintered render meshes (shards.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpus, loadavg } from "node:os";
import { simulate, qyaw } from "../../web/stage/physics.mjs";
import { voronoiCells, fractureNetwork, networkJoints, jointResponse, bendMember, glueGroups, clipPoly, BREAK_MATERIALS, NETWORK,
  MAX_NETWORK_CELLS, seedOf } from "../../web/stage/fracture.mjs";
import { shardGeometry } from "../../web/stage/shards.mjs";
import { vehicleBodyPoints } from "../../web/stage/convex.mjs";

const HALF = [0.4, 0.4, 0.4];
const polyVolume = (faces) => {
  const pts = faces.flatMap((f) => f.pts), c = pts.reduce((s, p) => [s[0] + p[0] / pts.length, s[1] + p[1] / pts.length, s[2] + p[2] / pts.length], [0, 0, 0]);
  let V = 0;
  for (const f of faces) for (let i = 1; i + 1 < f.pts.length; i++) {
    const a = f.pts[0].map((v, k) => v - c[k]), b = f.pts[i].map((v, k) => v - c[k]), d = f.pts[i + 1].map((v, k) => v - c[k]);
    V += (a[0] * (b[1] * d[2] - b[2] * d[1]) - a[1] * (b[0] * d[2] - b[2] * d[0]) + a[2] * (b[0] * d[1] - b[1] * d[0])) / 6;
  }
  return V;
};

test("Voronoi cells partition the board, and the wood metric stretches them along the grain", () => {
  const off = [0, 0, 0], half = [0.5, 0.1, 0.02];
  const seeds = [[-0.3, 0.02, 0], [0.05, -0.05, 0], [0.31, 0.04, 0], [0.12, 0.06, 0]];
  const iso = voronoiCells(off, half, seeds), wood = voronoiCells(off, half, seeds, { grain: 0, aniso: 0.3 });
  for (const cells of [iso, wood]) {
    assert.equal(cells.length, 4);
    const V = cells.reduce((s, c) => s + polyVolume(c.faces), 0);
    assert.ok(Math.abs(V - 8 * half[0] * half[1] * half[2]) < 1e-9, `cells fill the board: ${V}`);
  }
  // Grain: in the stretched metric the cuts run more along the grain (x), so cell faces shared between cells point
  // more across it (their normals have less x) than with the plain metric.
  const along = (cells) => {
    let s = 0, n = 0;
    for (const c of cells) for (const f of c.faces) if (/^c/.test(f.tag)) {
      const P = f.pts, e1 = P[1].map((v, k) => v - P[0][k]), e2 = P[2].map((v, k) => v - P[0][k]);
      const nx = e1[1] * e2[2] - e1[2] * e2[1], ny = e1[2] * e2[0] - e1[0] * e2[2], nz = e1[0] * e2[1] - e1[1] * e2[0];
      s += Math.abs(nx) / Math.hypot(nx, ny, nz); n++;
    }
    return s / n;
  };
  assert.ok(along(wood) < along(iso), `grain ${along(wood).toFixed(2)} vs plain ${along(iso).toFixed(2)}`);
  // clipPoly: a box cut in half is half the volume and has a new face on the cut.
  const half1 = clipPoly(voronoiCells(off, [0.5, 0.5, 0.5], [[0, 0, 0]])[0].faces, [1, 0, 0], 0, "cut");
  assert.ok(Math.abs(polyVolume(half1) - 0.5) < 1e-9 && half1.some((f) => f.tag === "cut"));
});

test("fracture network: boards cut into Voronoi cells, clustered at the hit; typed joints; one glued piece; seeded", () => {
  const even = fractureNetwork(HALF, { material: "wood", seed: 5 }), hit = fractureNetwork(HALF, { material: "wood", seed: 5, impact: [0, 0.1, 0.4] });
  for (const f of [even, hit]) {
    assert.ok(f.pieces.length >= 8 && f.pieces.length <= MAX_NETWORK_CELLS, `${f.pieces.length}`);
    assert.ok(f.joints.some((j) => j.type === "nail") && f.joints.some((j) => j.type === "fiber"));
    assert.equal(glueGroups(f, f.joints.map(() => true), f.pieces.map((_, i) => i)).length, 1);
    for (const p of f.pieces) for (const v of p.v) for (let k = 0; k < 3; k++) assert.ok(Math.abs(v[k]) <= HALF[k] + 1e-9);
  }
  // Clustering: the boards nearest the hit (the +z face) are cut into more cells than with no hit.
  const front = (f) => f.pieces.filter((p) => p.off[2] > 0.3).length;
  assert.ok(front(hit) > front(even), `front cells ${front(hit)} vs ${front(even)}`);
  assert.deepEqual(fractureNetwork(HALF, { material: "wood", seed: 9, impact: [0.2, 0.3, 0.4] }), fractureNetwork(HALF, { material: "wood", seed: 9, impact: [0.2, 0.3, 0.4] }));
  const card = fractureNetwork(HALF, { material: "cardboard", seed: 5, impact: [0, 0.4, 0] });
  assert.ok(card.joints.some((j) => j.type === "crease"));
  assert.ok(card.pieces.some((p) => p.kind === "flap"));
});

test("joints: snap above their strength, bend (yield) between, keep damage below; boards bend inward, pinned at the ends", () => {
  const f = fractureNetwork(HALF, { material: "wood", seed: 3 }), J = networkJoints(f, BREAK_MATERIALS.wood.strength, 3);
  const fib = J.find((j) => j.type === "fiber"), nail = J.find((j) => j.type === "nail");
  assert.ok(fib.str > nail.str * 1.05, "fibre is stronger than nails");
  assert.ok(fib.yield < fib.str && fib.bend > 0 && nail.bend === 0);
  assert.equal(jointResponse(fib, fib.str * 1.01).snap, true);
  const y = jointResponse(fib, (fib.yield + fib.str) / 2);
  assert.ok(!y.snap && y.yield > 0 && y.damage > 0);
  assert.ok(jointResponse(nail, nail.str * 0.8).damage > 0 && !jointResponse(nail, nail.str * 0.8).snap, "a hard knock below strength still damages");
  assert.equal(jointResponse(nail, nail.str * 0.3).damage, 0);
  assert.ok(NETWORK.cardboard.joints.crease.bend > NETWORK.wood.joints.fiber.bend, "creases fold further than wood bends");
  // Bend the struck front board 0.3 rad at its middle: its centre goes inwards (-z), its ends barely move.
  const m = f.members.findIndex((M) => M.normal[2] > 0.5 && M.cells.length >= 1);
  const M = f.members[m], moved = bendMember(f, m, 0.3, 0);
  for (const e of moved) {
    const p0 = f.pieces[e.i].off, s = (p0[M.axis] - M.off[M.axis]) / M.half[M.axis];
    assert.ok(e.o[2] <= p0[2] + 1e-12, "never outwards");
    if (Math.abs(s) < 0.3) assert.ok(p0[2] - e.o[2] > 0.02, `middle cell pushed in ${(p0[2] - e.o[2]).toFixed(3)}`);
  }
});

const crate = (id, pos, { mat = "wood", yaw = 0 } = {}) => {
  const cfg = BREAK_MATERIALS[mat], seed = seedOf(id);
  return { id, shape: "box", half: HALF, center: [0, 0.4, 0], dynamic: true, mass: 25, bounce: 0.2, friction: 0.6, material: mat,
    poses: [{ pos, quat: qyaw(yaw) }], breakable: { lazy: true, material: mat, strength: cfg.strength, burst: cfg.burst, seed }, dent: cfg.dent };
};
const car = (F, from = -8, speed = 0.5) => {
  const poses = [];
  for (let f = 0; f < F; f++) poses.push({ pos: [0, 0, from + f * speed], quat: [0, 0, 0, 1] });
  return { id: "car#body", shape: "hull", hulls: [vehicleBodyPoints([0.9, 0.35, 2.2], [0, 0.45, 0])], half: [0.9, 0.35, 2.2], center: [0, 0.45, 0], dynamic: false, poses, material: "metal" };
};

test("in the bake: a drop leaves a crate whole; a car cracks, bends and breaks it; deterministic; debris rides the car's motion", () => {
  const low = simulate([crate("d", [0, 0.4, 0])], 36);
  assert.deepEqual(low.fractures, {}, "a 0.4 m drop doesn't break a crate");
  const F = 48, specs = () => [car(F), crate("c", [0, 0, 3])];
  const a = simulate(specs(), F), b = simulate(specs(), F);
  assert.equal(JSON.stringify(a.tracks), JSON.stringify(b.tracks));
  assert.equal(JSON.stringify(a.fractures), JSON.stringify(b.fractures));
  const fr = a.fractures.c;
  assert.ok(fr && fr.network && fr.split != null && fr.split >= fr.frame, JSON.stringify({ frame: fr?.frame, split: fr?.split }));
  assert.ok(fr.cracks > 0 && fr.pieces.length >= 8);
  for (const p of fr.pieces) {
    assert.ok(p.v.length >= 4 && p.faces.length >= 4, "every piece carries its cell for the render mesh");
    assert.equal(p.track.length, F);
  }
  // Before the network existed every cell rode with the crate.
  const c0 = a.tracks.c[fr.frame - 3].pos;
  for (const p of fr.pieces) assert.ok(Math.abs(p.track[fr.frame - 3].pos[2] - (c0[2] + p.center[2])) < 0.02);
  // Pieces leave the hit moving the car's way (+z), and nothing explodes.
  const vz = fr.pieces.map((p) => (p.track[fr.split + 3].pos[2] - p.track[fr.split + 1].pos[2]) * 12);
  assert.ok(vz.filter((v) => v > 3).length >= fr.pieces.length / 2, `vz ${vz.map((v) => v.toFixed(1))}`);
  for (const p of fr.pieces) for (let f = 1; f < F; f++) {
    const u = p.track[f - 1].pos, w = p.track[f].pos;
    assert.ok(Math.hypot(u[0] - w[0], u[1] - w[1], u[2] - w[2]) * 24 < 25);
  }
  const brk = a.events.find((e) => e.break && e.a === "c");
  assert.ok(brk && brk.frame === fr.split);
});

test("progressive: a 4.5 m/s nudge only cracks and bends the crate (still one piece); the 12 m/s blow later breaks it", () => {
  const F = 60, poses = [];
  for (let f = 0; f < F; f++) poses.push({ pos: [0, 0, -3.2 + Math.min(f, 14) * 4.5 / 24 + Math.max(0, f - 40) * 0.5], quat: [0, 0, 0, 1] });
  const r = simulate([{ ...car(F), poses }, crate("c", [0, 0, 0])], F);
  const fr = r.fractures.c;
  assert.ok(fr, "the first blow left a mark");
  assert.ok(fr.frame < 20 && fr.split >= 40, `marked at ${fr.frame}, split at ${fr.split}`);
  // Between the blows some cell sits turned (bent) or moved (a crack opened) inside the crate.
  const t = 30, base = r.tracks.c[t], q0 = base.quat;
  const changed = fr.pieces.some((p) => {
    const q = p.track[t].quat, dq = Math.abs(q[0] * q0[0] + q[1] * q0[1] + q[2] * q0[2] + q[3] * q0[3]);
    return dq < 0.99995;
  });
  assert.ok(changed || fr.cracks > 0, "bent or cracked between the blows");
});

test("render mesh: cut faces torn up, splinters on boards snapped across the grain, outward and seeded", () => {
  const f = fractureNetwork(HALF, { material: "wood", seed: 5, impact: [0, 0.1, 0.4] });
  let spl = 0, tris = 0;
  for (const [i, p] of f.pieces.entries()) {
    const g = shardGeometry(p, { material: "wood", seed: i + 1 });
    assert.deepEqual(g, shardGeometry(p, { material: "wood", seed: i + 1 }));
    spl += g.splinters; tris += g.indices.length / 3;
    // closed and outward: positive volume
    let V = 0;
    const P = g.positions;
    for (let k = 0; k < g.indices.length; k += 3) {
      const a = g.indices[k] * 3, b = g.indices[k + 1] * 3, c = g.indices[k + 2] * 3;
      V += (P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c])) / 6;
    }
    assert.ok(V > 0, `piece ${i} is inside out`);
  }
  assert.ok(spl >= 5, `${spl} splinters`);
  assert.ok(tris > 20 * f.pieces.length, `${tris} triangles: more detail than the hulls`);
  const card = fractureNetwork(HALF, { material: "cardboard", seed: 5, impact: [0, 0.4, 0] });
  const g = shardGeometry(card.pieces.find((p) => p.faces.some((x) => x.tag === "cut")) || card.pieces[0], { material: "cardboard", seed: 2 });
  assert.equal(g.splinters, 0, "cardboard tears, it doesn't splinter");
});

// Bake time (load-aware). This Mac is shared with other agents, Chrome and Avid; at a load of 30-250 a single-threaded
// bake can take 3-15x its idle time, so wall-clock limits flake. The test measures CPU time and compares the
// breakable crash with the same scene's rigid bake in the same process (both slowed alike): the network costs at most
// 4.5x the rigid bake. When the machine is not overloaded it also checks the absolute target (under 4 s of CPU).
test("bake time: the crate crash with the network costs at most 4.5x its rigid bake (and < 4 s CPU when the machine is idle)", () => {
  const F = 121, scene = (brk) => {
    const specs = [car(F, -24, 0.45)];
    let k = 0;
    for (const [y, xs] of [[0, [-1.2, -0.4, 0.4, 1.2]], [0.8, [-0.8, 0, 0.8]], [1.6, [-0.4, 0.4]], [2.4, [0]]]) {
      for (const x of xs) { const c = crate(`crate_${k}`, [x + 0.02 * k, y, 6], { yaw: 0.05 * k }); if (!brk) { delete c.breakable; delete c.dent; } specs.push(c); k++; }
    }
    return specs;
  };
  const cpu = (brk) => { const c0 = process.cpuUsage(), r = simulate(scene(brk), F), c = process.cpuUsage(c0); return { ms: (c.user + c.system) / 1000, r }; };
  const rigid = cpu(false), net = cpu(true);
  const broke = Object.values(net.r.fractures).filter((f) => f.split != null).length;
  console.log(`# crate crash: rigid ${rigid.ms.toFixed(0)} ms, network ${net.ms.toFixed(0)} ms CPU (x${(net.ms / rigid.ms).toFixed(2)}); ${broke} broke, ${net.r.stats.pieces} loose bodies; load ${loadavg()[0].toFixed(0)}`);
  assert.ok(broke >= 3, `broke ${broke}`);
  assert.ok(net.ms < 4.5 * rigid.ms + 500, `network ${net.ms.toFixed(0)} ms vs rigid ${rigid.ms.toFixed(0)} ms`);
  if (loadavg()[0] < 0.75 * cpus().length) assert.ok(net.ms < 4000, `network bake ${net.ms.toFixed(0)} ms CPU on an idle machine`);
});
