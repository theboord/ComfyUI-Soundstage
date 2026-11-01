#!/usr/bin/env node
// Run the physics benchmark scenes through Soundstage's XPBD bake (web/stage/physics.mjs simulate(), the solver every
// shot is baked with) and write per-frame poses for every body.
//
//   node tools/physbench/run_soundstage.mjs [--out out/soundstage_default.json] [--substeps 20] [--iterations 2]
//        [--physics path/to/physics.mjs] [--label default]
//
// Defaults are the stage's own bake settings (stage.mjs: substeps 20; physics.mjs simulate()'s own contact passes).
// Materials: scenes.json holds effective pair values; Soundstage combines friction as sqrt(a*b) and restitution as
// max(a, b), and its floor is friction 0.8 / restitution 0, so the scene values go in unchanged. Imperfection jitter
// and breakables are off (they are stage-level features; this measures the rigid solver).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith("--") ? [...a, [v.slice(2), all[i + 1]]] : a), []));
const physPath = resolve(args.physics || resolve(here, "../../web/stage/physics.mjs"));
const { simulate } = await import(pathToFileURL(physPath).href);
const scenes = JSON.parse(readFileSync(resolve(here, args.scenes || "scenes.json"), "utf8"));
const opts = { substeps: +(args.substeps || 20), iterations: args.iterations ? +args.iterations : undefined };   // undefined: the engine default
const label = args.label || `ss_sub${opts.substeps}_it${opts.iterations ?? "default"}`;
const only = args.scene ? new Set(args.scene.split(",")) : null;

const out = { engine: "soundstage-xpbd", label, physics: physPath, settings: opts, fps: scenes.fps, scenes: {} };
for (const sc of scenes.scenes) {
  if (only && !only.has(sc.name)) continue;
  const F = sc.frames;
  const specs = sc.bodies.map((b) => {
    const half = b.size.map((v) => v / 2);
    let poses;
    if (b.keys) poses = Array.from({ length: F }, (_, f) => ({ pos: b.keys[Math.min(f, b.keys.length - 1)], quat: b.quat }));
    else poses = [{ pos: b.pos, quat: b.quat }];
    return { id: b.id, shape: "box", half, center: [0, 0, 0], dynamic: b.type === "dynamic", mass: b.mass, bounce: b.restitution,
      friction: b.friction, poses, release: b.type === "dynamic" ? (b.release || 0) : 0, material: "wood" };
  });
  const t0 = performance.now();
  const r = simulate(specs, F, { fps: scenes.fps, gravity: sc.gravity, substeps: opts.substeps, iterations: opts.iterations, events: true });
  const ms = performance.now() - t0;
  const tracks = {};
  for (const b of sc.bodies) {
    if (r.tracks[b.id]) tracks[b.id] = r.tracks[b.id].map((p) => [...p.pos, ...p.quat]);
    else if (b.keys) tracks[b.id] = Array.from({ length: F }, (_, f) => [...b.keys[Math.min(f, b.keys.length - 1)], ...b.quat]);
    else tracks[b.id] = Array.from({ length: F }, () => [...b.pos, ...b.quat]);
  }
  out.scenes[sc.name] = { frames: F, ms: +ms.toFixed(1), tracks, settled: r.settled, impacts: r.events.length, stats: r.stats };
  console.log(`${label} ${sc.name}: ${F} frames, ${ms.toFixed(0)} ms, ${r.events.length} impacts`);
}
const file = resolve(here, args.out || `out/${label}.json`);
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, JSON.stringify(out));
console.log("wrote", file);
