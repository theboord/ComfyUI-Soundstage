// Soft-body Presets cards (Milestone 28): "Tarp in the wind", "Rope bridge", "Cardboard box crush", "Sand pile".
// Each adds the soft body (and what it needs: posts, a car driving through) to the scene, then Simulate & bake runs the
// rigid bodies and the soft bodies, so the card's result is baked keys and a vertex cache, like the other physics cards.
import { driveKeys } from "./engine.mjs";

export const SOFT_PRESET_KINDS = ["tarp_wind", "rope_bridge", "cardboard_crush", "sand_pile"];
const DEG = Math.PI / 180;
const R3 = (v) => v.map((x) => Math.round(x * 1000) / 1000);
const post = (id, name, xs, h = 2.6, z = 0) => ({ id, name, kind: "custom", position: [0, 0, 0], keys: [{ frame: 0, position: [0, 0, 0] }], rotation_deg: 0, physics: { mode: "off" },
  recipe: { color: "#6b5a46", parts: xs.map((x) => ({ shape: "cylinder", size: [0.09, h, 0.09], pos: [x, h / 2, z] })) } });

/** Run one soft preset through a PresetRunner (its scene / _loadState / _vehicle / _pos / _heading / stage helpers). */
export function softPreset(run, p) {
  const st = run.stage, kind = p.apply.physics, last = run._last(), stamp = Date.now().toString(36);
  const s2 = run.scene();
  const cam = s2.camera || {};
  // Where to put it: in front of the camera, on the floor (or in the car's path).
  const tgt = cam.target || [0, 0, 0];
  const at = [tgt[0], 0, tgt[2]];
  const v = run._vehicle();
  let said = "", where = "the set";
  const add = (a) => { s2.actors.push(a); return a; };
  const place = (a, pos, deg = 0) => { a.position = R3(pos); a.keys = [{ frame: 0, position: R3(pos) }]; a.rotation_deg = deg; };
  const inPath = (dist) => {
    const car = s2.actors.find((x) => x.id === v.id);
    const start = run._pos(car, 0), deg = run._heading(car), dir = [Math.sin(deg * DEG), 0, Math.cos(deg * DEG)];
    if (v.stunt) st.applyStunt?.(v.id, "none");
    if ((car.keys || []).length < 2) { car.keys = driveKeys(start, deg, 22, last); delete car.position_end; }
    return { pos: [start[0] + dir[0] * dist, 0, start[2] + dir[2] * dist], deg };
  };
  if (kind === "tarp_wind") {
    const id = `tarp_${stamp}`;
    const tarp = add({ id, name: "Tarp", kind: "tarp", height_m: 2.4, physics: { mode: "soft", soft: { wind: p.apply.wind ?? 8, gust: 0.7, wind_deg: 90 } } });
    place(tarp, at, 0);
    const posts = add(post(`tarp_posts_${stamp}`, "Tarp posts", [-1.55, 1.55], 2.55));
    place(posts, at, 0);
    said = `A 3 × 2 m tarp tied between two posts, flapping in an ${p.apply.wind ?? 8} m/s gusty wind`;
  } else if (kind === "rope_bridge") {
    const id = `bridge_${stamp}`;
    const b = add({ id, name: "Rope bridge", kind: "rope_bridge", height_m: 1.6, physics: { mode: "soft", soft: { wind: 2 } } });
    place(b, at, 0);
    const posts = add(post(`bridge_posts_${stamp}`, "Bridge posts", [-4.05, -4.05, 4.05, 4.05], 2.6));
    posts.recipe.parts = [[-4.05, -0.55], [-4.05, 0.55], [4.05, -0.55], [4.05, 0.55]].map(([x, z]) => ({ shape: "cylinder", size: [0.12, 2.6, 0.12], pos: [x, 1.3, z] }));
    place(posts, at, 0);
    said = "An 8 m rope bridge between four posts: the deck sags in a catenary and sways in the wind";
  } else if (kind === "cardboard_crush") {
    const id = `cardboard_${stamp}`;
    const box = add({ id, name: "Cardboard box", kind: "cardboard", height_m: 0.45, physics: { mode: "soft", soft: {} } });
    if (v) { const q = inPath(9); place(box, q.pos, q.deg); where = `the ${v.name || v.kind}'s path`; said = `A cardboard box in the ${(v.name || v.kind).toLowerCase()}'s path: it drives over it and the box folds flat and stays crushed`; }
    else {
      place(box, at, 0);
      // A crate comes down on it (keyed, a press): the box buckles and creases under it.
      const c = add({ id: `press_${stamp}`, name: "Crate", kind: "crate", height_m: 0.6, rotation_deg: 8, physics: { mode: "static" } });
      const top = 2.2;
      c.position = R3([at[0], top, at[2]]);
      c.keys = [{ frame: 0, position: R3([at[0], top, at[2]]) }, { frame: 18, position: R3([at[0], 0.46, at[2]]) }, { frame: 30, position: R3([at[0], 0.16, at[2]]) }, { frame: last, position: R3([at[0], 0.16, at[2]]) }];
      said = "A crate comes down on a cardboard box: it buckles, creases and stays crushed";
    }
  } else if (kind === "sand_pile") {
    const id = `sand_${stamp}`;
    const pile = add({ id, name: "Sand pile", kind: p.apply.material === "gravel" ? "gravel_pile" : "sand_pile", height_m: 0.9, physics: { mode: "soft", soft: {} } });
    if (v) { const q = inPath(10); place(pile, [q.pos[0] + Math.cos(q.deg * DEG) * 0.6, 0, q.pos[2] - Math.sin(q.deg * DEG) * 0.6], 0); where = `the ${v.name || v.kind}'s path`; said = `A sand pile in the ${(v.name || v.kind).toLowerCase()}'s path: it slumps, and the car ploughs through and spills it`; }
    else { place(pile, at, 0); said = "A steep sand pile dumped on the floor: it slumps and spills out to a low heap"; }
  } else return { ok: false, said: `Unknown soft preset ${kind}.` };
  run._loadState(s2);
  const r = st.simulatePhysics?.() || { ok: true, message: "" };
  return { ok: r.ok !== false, said: `Applied '${p.label}': ${said}. ${r.message || ""}`.trim(), whereObj: where };
}

/** Thumbnail (side view) for a soft preset card; u is the loop phase 0..1. */
export function drawSoftThumb(c, kind, u, w, h, gy, S) {
  if (kind === "tarp_wind") {
    c.fillStyle = "#6b5a46"; c.fillRect(w * 0.22, gy - S * 2.6, 3, S * 2.6); c.fillRect(w * 0.78, gy - S * 2.6, 3, S * 2.6);
    c.fillStyle = "#4f6b7a"; c.beginPath(); c.moveTo(w * 0.22, gy - S * 2.5);
    for (let i = 0; i <= 10; i++) { const x = w * (0.22 + 0.56 * i / 10); c.lineTo(x, gy - S * 2.5 + Math.sin(i * 0.6 + u * 12) * 3 + S * 0.15 * Math.sin(i / 10 * Math.PI)); }
    for (let i = 10; i >= 0; i--) { const x = w * (0.22 + 0.56 * i / 10) + Math.sin(i * 0.9 + u * 12) * 6 + 8; c.lineTo(x, gy - S * 0.6 + Math.sin(i * 0.7 + u * 14) * 4); }
    c.closePath(); c.fill();
  } else if (kind === "rope_bridge") {
    c.fillStyle = "#6b5a46"; c.fillRect(w * 0.12, gy - S * 2.6, 3, S * 2.6); c.fillRect(w * 0.88, gy - S * 2.6, 3, S * 2.6);
    c.strokeStyle = "#8a6a44"; c.lineWidth = 3; c.beginPath();
    for (let i = 0; i <= 20; i++) { const t = i / 20, x = w * (0.12 + 0.76 * t), y = gy - S * 1.6 + Math.sin(t * Math.PI) * S * (0.5 + 0.06 * Math.sin(u * 6.3)); i ? c.lineTo(x, y) : c.moveTo(x, y); }
    c.stroke(); c.lineWidth = 1.5; c.beginPath();
    for (let i = 0; i <= 20; i++) { const t = i / 20, x = w * (0.12 + 0.76 * t), y = gy - S * 2.5 + Math.sin(t * Math.PI) * S * 0.35; i ? c.lineTo(x, y) : c.moveTo(x, y); }
    c.stroke();
  } else if (kind === "cardboard_crush") {
    const k = Math.min(1, Math.max(0, (u - 0.35) * 3)), bh = S * 0.9 * (1 - 0.7 * k);
    c.fillStyle = "#b08a5a"; c.beginPath(); c.moveTo(w * 0.42, gy); c.lineTo(w * 0.42 - k * 6, gy - bh * 0.5); c.lineTo(w * 0.42, gy - bh); c.lineTo(w * 0.62, gy - bh); c.lineTo(w * 0.62 + k * 6, gy - bh * 0.5); c.lineTo(w * 0.62, gy); c.fill();
    const y = u < 0.35 ? gy - S * 2.4 + (u / 0.35) ** 2 * S * 1.5 : gy - bh;
    c.fillStyle = "#a7814f"; c.fillRect(w * 0.43, y - S * 0.7, w * 0.18, S * 0.7);
  } else if (kind === "sand_pile") {
    const k = Math.min(1, u * 1.6), hh = S * (1.6 - 0.9 * k), rr = S * (1.1 + 1.1 * k);
    c.fillStyle = "#c9a46e"; c.beginPath(); c.moveTo(w / 2 - rr, gy); c.quadraticCurveTo(w / 2, gy - hh * 2, w / 2 + rr, gy); c.fill();
  }
}
