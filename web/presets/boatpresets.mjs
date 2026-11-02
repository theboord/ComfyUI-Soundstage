// Watercraft Presets cards: "Speedboat run", "Sailing tack", "Canoe on a calm lake", "Whitewater raft".
// Each puts the boat (the selected one if it fits, else a new one) on water (switching to a lake, the open sea or the
// rapids if the set is dry), seats its crew, drives the boat sim (boatsim.mjs) through its helm script on the set's own
// waves and wind, and bakes the run into keys: the path, the throttle / trim / sheet / effort it used (Parts keys) and
// every stroke (so the crew pull when the hull surges). A camera that tells the story is keyed alongside.
import { simulateBoat, boatScript, boatKeys, strokeSpans, headingForTwa, isBoatKind } from "../stage/boatsim.mjs";
import { fieldFor } from "../stage/waves.mjs";

export const BOAT_PRESET_KINDS = ["speedboat_run", "sailing_tack", "canoe_lake", "whitewater_raft"];
const DEG = Math.PI / 180;
const R3 = (v) => Math.round(v * 1000) / 1000;

/** What each card needs: the boat kind, the set it moves to when the stage is dry, the sea state, the crew. */
export const BOAT_PRESETS = {
  speedboat_run: { boat: "speedboat", set: "lake", sea: "breeze", crew: [["man", 0], ["woman", 1]], words: "a speedboat run: the hole shot, the bow climbs and levels as it planes, a carving turn" },
  sailing_tack: { boat: "dinghy", set: "open_water", sea: "breeze", wind: 6.5, crew: [["man", 0]], words: "a dinghy beating to windward, tacking through the wind: the boom swings across and the sailor crosses the boat" },
  canoe_lake: { boat: "canoe", set: "lake", sea: "calm_lake", crew: [["woman", 0], ["man", 1]], words: "a tandem canoe gliding across a calm lake, the paddlers' strokes in time" },
  whitewater_raft: { boat: "raft", set: "river_rapids", sea: "whitewater", crew: [["man", 0], ["woman", 1], ["man", 2], ["woman", 3], ["man", 4], ["man", 5]], words: "a six-person raft running class III rapids, paddling hard and ferrying across the current" },
};

/** Camera keys that tell each run: a tracking boat alongside (speedboat), a low three-quarter (canoe, dinghy), from
 *  downstream (raft). From the run's own path, a key every 6 frames. */
export function boatCameraKeys(kind, run, last, { side = 1 } = {}) {
  const keys = [];
  const F = run.frames;
  for (let f = 0; f <= last; f += 6) {
    const s = F[Math.min(F.length - 1, f)];
    // A tack turns the boat ~100°: that camera holds the course it started on (a chase boat doesn't swing round with it).
    const hRef = kind === "sailing_tack" ? F[0].h : s.h;
    const sh = Math.sin(hRef), ch = Math.cos(hRef);
    const lx = ch * side, lz = -sh * side;           // the boat's left (side = 1) / right
    let pos, tgt, mm;
    if (kind === "speedboat_run") { pos = [s.x + lx * 14 - sh * 4, 2.2, s.z + lz * 14 - ch * 4]; tgt = [s.x + sh * 1.5, s.y + 0.9, s.z + ch * 1.5]; mm = 40; }
    else if (kind === "whitewater_raft") { pos = [s.x + sh * 16 + lx * 3, s.y + 3.2, s.z + ch * 16 + lz * 3]; tgt = [s.x, s.y + 0.6, s.z]; mm = 35; }
    else if (kind === "sailing_tack") { pos = [s.x + lx * 13 + sh * 6, 1.9, s.z + lz * 13 + ch * 6]; tgt = [s.x, s.y + 2.2, s.z]; mm = 35; }
    else { pos = [s.x + lx * 7 + sh * 5, s.y + 1.1, s.z + lz * 7 + ch * 5]; tgt = [s.x, s.y + 0.6, s.z]; mm = 35; }
    keys.push({ frame: f, position: pos.map(R3), target: tgt.map(R3), focal_mm: mm });
  }
  return keys;
}

/**
 * The script's beats fitted to the shot: a 4-5 s shot still shows the hole shot AND the start of the carve, the tack,
 * the canoe's turn and the raft's ferry (the scripts' own times are for a long take). Keys in `apply` win.
 */
export function fitTimes(id, dur, apply = {}) {
  const r1 = (v) => Math.round(v * 10) / 10, cl = (v, a, b) => Math.min(b, Math.max(a, v));
  let t = {};
  if (id === "speedboat_run") { const go = dur < 6 ? 0.25 : 0.5; t = { go_s: go, turn_s: r1(cl(dur - 1.4, go + 3.6, 6.5)) }; }
  else if (id === "sailing_tack") t = { tack_s: r1(cl(dur * 0.25, 1, 2.5)) };
  else if (id === "canoe_lake") t = { turn_s: r1(cl(dur * 0.5, 1.5, 5)) };
  else if (id === "whitewater_raft") t = { ferry_s: r1(cl(dur * 0.2, 0.8, 2.4)) };
  for (const k of Object.keys(t)) if (Number.isFinite(apply?.[k])) t[k] = apply[k];
  return t;
}

/** Run one boat preset through a PresetRunner. */
export function boatPreset(run, p) {
  const st = run.stage, id0 = p.apply.boat, spec = BOAT_PRESETS[id0];
  if (!spec) return { ok: false, said: `Unknown boat preset ${id0}.` };
  const last = run._last(), fps = run._fps(), stamp = Date.now().toString(36);
  const s2 = run.scene();
  const env = { ...(s2.environment || {}) };
  const watery = ["lake", "open_water", "river_rapids", "water_tank"].includes(env.set);
  let moved = "";
  if (!watery || (spec.set === "river_rapids" && env.set !== "river_rapids")) { env.set = spec.set; moved = ` (the set is now ${spec.set.replace("_", " ")})`; }
  if (!env.sea_state) env.sea_state = spec.sea;
  if (spec.wind) env.wind_mps = env.wind_mps ?? spec.wind;
  s2.environment = env;
  // The boat: the selected one if it is this kind, else any of this kind, else a new one.
  const sel = run.selected();
  let boat = sel && sel.kind === spec.boat ? s2.actors.find((a) => a.id === sel.id) : s2.actors.find((a) => a.kind === spec.boat);
  if (!boat) { boat = { id: `${spec.boat}_${stamp}`, name: p.label.split(" ")[0] === "Sailing" ? "Dinghy" : spec.boat[0].toUpperCase() + spec.boat.slice(1).replace("_", " "), kind: spec.boat, position: [0, 0, 0], keys: [{ frame: 0, position: [0, 0, 0] }] }; s2.actors.push(boat); }
  const start = boat.keys?.[0]?.position || boat.position || [0, 0, 0];
  // The waves and wind it will meet (the same field the stage floats it on).
  const F = fieldFor(env);
  const wind = [F.windDir[0] * (env.wind_mps ?? F.wind), F.windDir[1] * (env.wind_mps ?? F.wind)];
  const level = env.water_level ?? { lake: 1.2, open_water: 1.5, river_rapids: 1.4, water_tank: 2.5 }[env.set] ?? 1.2;
  let heading = (+boat.rotation_deg || 0) * DEG;
  if (id0 === "sailing_tack") heading = headingForTwa(wind, 48);
  if (id0 === "whitewater_raft") heading = 0;                 // downstream (the river runs toward +z)
  const script = boatScript(id0, fitTimes(id0, last / fps, p.apply));
  const res = simulateBoat(script, { frames: last + 1, fps, waves: F, wind, level, x: start[0], z: start[2], heading, kind: spec.boat });
  boat.keys = boatKeys(res, { every: 2 });
  boat.position = boat.keys[0].position;
  delete boat.position_end;
  boat.rotation_deg = +(heading / DEG).toFixed(2);
  boat.boat = { preset: id0, strokes: strokeSpans(res), sim: true };
  // The controls it used, as Parts keys (the float on playback uses the same throttle, trim, sheet and effort).
  const parts = { ...(boat.parts || {}) };
  const keyCh = (ch, get) => {
    const out = [];
    let prev = null;
    res.frames.forEach((s, f) => { const v = get(s); if (!Number.isFinite(v)) return; const r = Math.round(v * 100) / 100; if (r !== prev || f === res.frames.length - 1) { if (f % 4 === 0 || f === res.frames.length - 1 || prev === null) { out.push({ frame: f, v: r, i: "linear" }); prev = r; } } });
    if (out.length) parts[ch] = out;
  };
  if (spec.boat === "speedboat") { keyCh("throttle", (s) => s.ctl.throttle); keyCh("motor_trim", (s) => s.ctl.trim); }
  if (["canoe", "raft", "kayak", "rowboat"].includes(spec.boat)) keyCh("effort", (s) => s.ctl.effort);
  boat.parts = parts;
  // The crew: seat the people it needs (reuse unseated people on stage first).
  const free = s2.actors.filter((a) => ["man", "woman", "child"].includes(a.kind) && !a.mount_id);
  const seated = new Set(s2.actors.filter((a) => a.mount_id === boat.id).map((a) => a.seat ?? 0));
  spec.crew.forEach(([kind, seat], i) => {
    if (seated.has(seat)) return;
    let who = free.shift();
    if (!who) { who = { id: `crew_${stamp}_${i}`, name: `${kind === "woman" ? "Woman" : "Man"} ${i + 1}`, kind, position: start.map(R3), keys: [{ frame: 0, position: start.map(R3) }], height_m: kind === "woman" ? 1.68 : 1.8 }; s2.actors.push(who); }
    who.mount_id = boat.id; who.seat = seat; delete who.pose; delete who.mount_at;
  });
  run._loadState(s2);
  // A camera that shows it: keyed on the run.
  try { st.setCameraKeys?.(boatCameraKeys(id0, res, last)); } catch { /* no camera */ }
  const m = res.frames, top = Math.max(...m.map((s) => s.u));
  const extra = spec.boat === "speedboat" ? ` Peak trim ${Math.max(...m.map((s) => s.pitch)).toFixed(1)}° at the hump, ${(top * 1.944).toFixed(0)} kn on the plane.`
    : spec.boat === "dinghy" ? ` Through the wind at ${fitTimes(id0, last / fps, p.apply).tack_s} s; heel up to ${Math.max(...m.map((s) => Math.abs(s.roll))).toFixed(0)}°.`
    : ` ${strokeSpans(res).length} strokes, about ${(top * 1.944).toFixed(1)} kn.`;
  return { ok: true, said: `Applied '${p.label}': ${spec.words}${moved}.${extra}`, whereObj: `the ${(boat.name || spec.boat).toLowerCase()}` };
}

/** Is a kind a watercraft (the car presets skip them). */
export const isBoat = (a) => !!a && (isBoatKind(a.kind) || /boat|ski|sail|catamaran|canoe|kayak|raft|yacht|dinghy/.test(a.kind || ""));

/** Top-down card thumbnail: water, the boat crossing, its V wake (a tack turns through the wind). u: loop phase 0..1. */
export function drawBoatThumb(c, id, u, w, h) {
  c.fillStyle = id === "whitewater_raft" ? "#2f5566" : "#23465a"; c.fillRect(0, 0, w, h);
  c.strokeStyle = "rgba(255,255,255,.08)";
  for (let y = 6; y < h; y += 9) { c.beginPath(); for (let x = 0; x <= w; x += 6) c.lineTo(x, y + Math.sin(x * 0.15 + u * 12 + y) * 1.5); c.stroke(); }
  const x = w * (0.15 + 0.7 * u), y = h * 0.55;
  const hd = id === "sailing_tack" ? (u < 0.5 ? -0.5 : 0.5) : id === "speedboat_run" && u > 0.7 ? -0.3 * (u - 0.7) / 0.3 : 0;
  c.save(); c.translate(x, y); c.rotate(Math.PI / 2 + hd);
  c.strokeStyle = "rgba(240,248,255,.7)"; c.lineWidth = 1.2;
  const wl = id === "speedboat_run" ? 40 * Math.min(1, u * 2) : 18;
  c.beginPath(); c.moveTo(-wl * 0.36, wl); c.lineTo(0, 4); c.lineTo(wl * 0.36, wl); c.stroke();
  c.fillStyle = id === "canoe_lake" ? "#b5512f" : id === "whitewater_raft" ? "#d2452f" : "#f3f1ec";
  const L = id === "speedboat_run" ? 9 : 7;
  c.beginPath(); c.moveTo(0, -L); c.quadraticCurveTo(4, 0, 3, L * 0.6); c.lineTo(-3, L * 0.6); c.quadraticCurveTo(-4, 0, 0, -L); c.fill();
  if (id === "sailing_tack") { c.strokeStyle = "#f4f1e8"; c.lineWidth = 2; c.beginPath(); c.moveTo(0, -2); c.lineTo(u < 0.5 ? 7 : -7, 5); c.stroke(); }
  c.restore();
}
