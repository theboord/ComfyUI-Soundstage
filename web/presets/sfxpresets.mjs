// Practical-effects Presets cards (SFX rigs, sfx.mjs): "Car explosion", "Building blast", "Sparks shower", "Squib hit".
// Each rigs the effect the way an SFX crew would (charges, cues, chains), adds what it needs when the set has none (a
// car, a breakaway wall, a stunt performer), then Simulate & bake makes the set react, like the other physics cards.
// Every card can be taken back with one Undo, or with the rig's Reset to before.
import { makeRig } from "../stage/sfx.mjs";

export const SFX_PRESET_KINDS = ["car_explosion", "building_blast", "sparks_shower", "squib_hit"];
const DEG = Math.PI / 180;
const R3 = (v) => v.map((x) => Math.round(x * 1000) / 1000);
const at = (id, name, kind, pos, extra = {}) => ({ id, name, kind, position: R3(pos), keys: [{ frame: 0, position: R3(pos) }], rotation_deg: 0, ...extra });

/** Run one SFX preset through a PresetRunner (its scene / _loadState / _vehicle / _person / _pos / _heading / stage helpers). */
export function sfxPreset(run, p) {
  const st = run.stage, kind = p.apply.physics, fps = run._fps(), last = run._last();
  const s2 = run.scene(), stamp = Date.now().toString(36);
  const cam = s2.camera || {}, tgt = cam.target || [0, 0, 0], here = [tgt[0], 0, tgt[2]];
  const cue = +(Math.min(Math.max(0.6, last / fps * 0.35), 2)).toFixed(2);   // early enough to see what follows
  const add = (a) => { s2.actors.push(a); return a; };
  let said = "", where = "the set";
  if (kind === "car_explosion") {
    let car = s2.actors.find((a) => a.id === run._vehicle()?.id);
    if (!car) car = add(at(`car_${stamp}`, "Car", "car", here));
    else if ((car.keys || []).length > 1) {   // the gag is on a parked car: it stops where it is at the cue
      const p0 = run._pos(car, Math.round(cue * fps));
      car.keys = [{ frame: 0, position: R3(p0) }]; car.position = R3(p0); delete car.position_end;
    }
    const c = run._pos(car, 0), deg = run._heading(car), side = [Math.cos(deg * DEG), 0, -Math.sin(deg * DEG)];
    // The charge under the car's near sill, so it lifts that side and rolls the car away from it.
    const boom = add(makeRig("explosion", { id: `sfx_boom_${stamp}`, name: "Car explosion (mortar)", position: [c[0] + side[0] * 1.0, 0, c[2] + side[2] * 1.0],
      sfx: { trigger: { type: "time", at: cue }, power: p.apply.power ?? 2.2, radius: 9 } }));
    add(makeRig("fire", { id: `sfx_fire_${stamp}`, name: "Burning wreck (fire bars)", position: [c[0], 0, c[2]], sfx: { trigger: { type: "chain", after: boom.id, delay: 0.15 }, power: 1.6, radius: 1.4 } }));
    said = `A pyro mortar under the ${(car.name || "car").toLowerCase()}'s sill fires at ${cue} s: a fireball, the shockwave, the car thrown over, then it burns`;
    where = `the ${car.name || car.kind}`;
  } else if (kind === "building_blast") {
    const d = 6, wallPos = [here[0], 0, here[2] - d];
    let wall = s2.actors.find((a) => a.kind === "wall");
    if (!wall) wall = add(at(`wall_${stamp}`, "Breakaway wall", "wall", wallPos, { scale: 1.6, physics: { material: "stone", weak: true } }));
    const w = run._pos(wall, 0);
    const boom = add(makeRig("explosion", { id: `sfx_blast_${stamp}`, name: "Building blast (charges)", position: [w[0], 0.4, w[2] + 0.6],
      sfx: { trigger: { type: "time", at: cue }, power: p.apply.power ?? 3.6, radius: 14 } }));
    add(makeRig("smoke_bomb", { id: `sfx_dust_${stamp}`, name: "Dust and smoke", position: [w[0], 0, w[2]], sfx: { trigger: { type: "chain", after: boom.id, delay: 0.1 }, color: "grey", power: 2.2, duration: 8 } }));
    for (let i = 0; i < 3; i++) add(at(`crate_${stamp}_${i}`, `Crate ${i + 1}`, "crate", [w[0] - 1.5 + 1.5 * i, 0, w[2] + 2.2]));
    said = `Charges at the foot of the wall fire at ${cue} s: the blocks blow out in a fireball and a rolling cloud of dust, the crates in front are thrown`;
    where = "the wall";
  } else if (kind === "sparks_shower") {
    add(makeRig("sparks", { id: `sfx_sparks_${stamp}`, name: "Sparks shower (gerb)", position: [here[0], 3.2, here[2]], sfx: { trigger: { type: "time", at: Math.min(cue, 1) }, power: 1.4, duration: p.apply.duration ?? 3 } }));
    said = `A shower of sparks pours down from 3 m from ${Math.min(cue, 1)} s for ${p.apply.duration ?? 3} s, bouncing off the floor, lighting the set orange`;
  } else if (kind === "squib_hit") {
    let who = s2.actors.find((a) => a.id === run._person?.()?.id);
    if (!who) who = add(at(`man_${stamp}`, "Stunt performer", "man", here));
    const c = run._pos(who, 0), deg = run._heading(who), fwd = [Math.sin(deg * DEG), 0, Math.cos(deg * DEG)], side = [Math.cos(deg * DEG), 0, -Math.sin(deg * DEG)];
    // Bullet hits walking in across the ground towards them, then the body squib on the chest (a chain, 0.12 s apart).
    let prev = null;
    for (let i = 0; i < 3; i++) {
      const q = [c[0] + fwd[0] * 0.8 + side[0] * (2.2 - 0.7 * i), 0, c[2] + fwd[2] * 0.8 + side[2] * (2.2 - 0.7 * i)];
      const r = add(makeRig("squib", { id: `sfx_sq_${stamp}_${i}`, name: `Ground squib ${i + 1}`, position: q,
        sfx: { surface: "ground", ...(prev ? { trigger: { type: "chain", after: prev, delay: 0.12 } } : { trigger: { type: "time", at: cue } }) } }));
      prev = r.id;
    }
    add(makeRig("body_squib", { id: `sfx_body_${stamp}`, name: "Body squib (chest)", position: [c[0], 1.3, c[2]],
      sfx: { target: who.id, point: "chest", trigger: { type: "chain", after: prev, delay: 0.12 }, power: 1 } }));
    said = `Three bullet-hit squibs kick up the ground towards ${who.name || "the performer"} from ${cue} s, then the body squib on the chest: a puff of fabric and stage blood, the jolt back, the fall`;
    where = who.name || "the performer";
  } else return { ok: false, said: `Unknown SFX preset ${kind}.` };
  run._loadState(s2);
  const r = st.simulatePhysics?.() || { ok: true, message: "" };
  return { ok: r.ok !== false, said: `Applied '${p.label}': ${said}. ${r.message || ""}`.trim(), whereObj: where };
}

/** Thumbnail (side view) for an SFX preset card; u is the loop phase 0..1. */
export function drawSfxThumb(c, kind, u, w, h, gy, S) {
  const boom = (x, y, k) => {
    if (k <= 0) return;
    const r = S * (0.4 + 1.6 * Math.min(1, k * 1.8));
    const g = c.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(255,236,170,${Math.max(0, 1 - k)})`); g.addColorStop(0.45, `rgba(255,140,40,${Math.max(0, 0.9 - k)})`); g.addColorStop(1, "rgba(60,50,45,0)");
    c.fillStyle = g; c.beginPath(); c.arc(x, y, r, 0, 7); c.fill();
  };
  if (kind === "car_explosion") {
    const k = Math.max(0, u - 0.3) / 0.7, roll = Math.min(Math.PI, k * 5), lift = Math.sin(Math.min(Math.PI, k * 4)) * S * 1.2;
    c.save(); c.translate(w * 0.5, gy - S * 0.5 - lift); c.rotate(roll);
    c.fillStyle = "#c4473f"; c.fillRect(-S * 1.4, -S * 0.3, S * 2.8, S * 0.6); c.fillRect(-S * 0.7, -S * 0.75, S * 1.3, S * 0.5);
    c.fillStyle = "#111"; c.beginPath(); c.arc(-S * 0.8, S * 0.35, S * 0.25, 0, 7); c.arc(S * 0.8, S * 0.35, S * 0.25, 0, 7); c.fill();
    c.restore();
    boom(w * 0.42, gy - S * 0.4, k);
  } else if (kind === "building_blast") {
    const k = Math.max(0, u - 0.25) / 0.75;
    for (let r = 0; r < 4; r++) for (let i = 0; i < 4; i++) {
      const out = k * (1 + 0.3 * i) * S * (r < 2 ? 2.4 : 1);
      c.fillStyle = "#8f8a84"; c.fillRect(w * 0.42 + i * S * 0.5 + out * 0.6, gy - (r + 1) * S * 0.5 + Math.min(r * S * 0.5, k * k * S * 2), S * 0.48, S * 0.46);
    }
    boom(w * 0.5, gy - S * 0.6, k);
  } else if (kind === "sparks_shower") {
    c.fillStyle = "#ffd25a";
    for (let i = 0; i < 40; i++) {
      const t = (u * 3 + i / 40) % 1, x = w * 0.5 + Math.sin(i * 12.9) * S * 1.2 * t, y = gy - S * 3 + t * t * S * 3;
      c.fillRect(x, Math.min(gy - 1, y), 2, 2 + 3 * t);
    }
  } else if (kind === "squib_hit") {
    const k = u * 1.6, fall = Math.max(0, Math.min(1, (k - 0.9) / 0.5));
    for (let i = 0; i < 3; i++) { const t = k - 0.2 - i * 0.12; if (t > 0 && t < 0.4) { c.fillStyle = `rgba(150,130,110,${1 - t / 0.4})`; c.beginPath(); c.arc(w * (0.18 + 0.1 * i), gy - t * S * 1.5, S * (0.2 + t), 0, 7); c.fill(); } }
    c.save(); c.translate(w * 0.62, gy); c.rotate(-fall * 1.45);
    c.fillStyle = "#e9e3d8"; c.fillRect(-S * 0.18, -S * 1.8, S * 0.36, S * 1.8); c.beginPath(); c.arc(0, -S * 2.0, S * 0.2, 0, 7); c.fill();
    if (k > 0.75) { c.fillStyle = "#8a1018"; c.beginPath(); c.arc(0, -S * 1.35, S * 0.09 + Math.min(1, k - 0.75) * S * 0.06, 0, 7); c.fill(); }
    c.restore();
  }
}
