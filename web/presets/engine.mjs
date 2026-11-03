// Presets (Milestone 17): the pure part. No DOM, no THREE, so node tests, the panel, the thumbnails and the Director
// all use the same numbers.
//
//   import { loadCatalog, cameraKeys, lightingPlan, editStyleCut, searchPresets } from "./engine.mjs";
//   const cat = await loadCatalog();                       // presets.json + the Looks tab from look/style_presets.json
//   cameraKeys(k0, { move: "crane_up", metres: 2.5 }, 96)  // -> { keys: [{frame, position, target, focal_mm}], ... }
//
// Conventions (stage space): y up, metres, a camera key is { frame, position:[x,y,z], target:[x,y,z], focal_mm }.

export const TAB_IDS = ["camera", "light", "look", "action", "edit", "recipe", "user"];
export const CAMERA_MOVES = ["push_in", "pull_out", "orbit", "crane_up", "crane_down", "dolly_zoom", "whip_pan", "follow",
  "drone_reveal", "tracking_side", "car_mount", "long_lens_pan", "arm_car"];
/** Moves keyed off a vehicle's whole path (the runner samples it into spec.path): world-space keys that never spin
 *  with the car, unlike car_mount. A long lens panning from a fixed base, and a camera car pacing alongside. */
export const CAR_PATH_MOVES = ["long_lens_pan", "arm_car"];
export const RIG_TYPES = ["free", "tripod", "dolly", "chapman", "slider", "jib", "steadicam", "handheld", "drone"];
export const TIME_KEYS = ["dawn", "golden_am", "midday", "overcast", "magic_hour", "blue_hour", "night", "keep"];
export const GRADE_KEYS = ["warmth", "contrast", "saturation", "grain", "halation", "vignette"];
export const STUNT_KINDS = ["reverse_jturn", "donut", "handbrake_180"];
export const PHYSICS_KINDS = ["crate_crash", "drop", "throw", "tarp_wind", "rope_bridge", "cardboard_crush", "sand_pile"];   // the last four: soft bodies (Milestone 28)
/** Camera shake on impact (Milestone 21): the shot camera jolts with each baked hit. */
export const SHAKE_KINDS = ["light", "heavy", "earthquake", "off"];
/** Swim presets (web/stage/swim.mjs): under water (flutter, frog) or at the surface (freestyle, breaststroke). */
export const SWIM_KINDS = ["flutter", "frog", "freestyle", "breaststroke"];
export const RECIPE_STEPS = ["video_to_3d", "new_angle", "ripple_mode", "whole_frame", "quality_draft", "quality_hollywood",
  "render_all_draft", "render_final"];
export const TRANSITION_TYPES = ["dissolve", "dip_black", "dip_white", "wipe"];
export const BOAT_KINDS = ["speedboat_run", "sailing_tack", "canoe_lake", "whitewater_raft"];   // watercraft (boatpresets.mjs)
export const VEHICLE_KINDS = new Set(["car", "truck", "police_car", "sports_car", "hatchback", "boat", "sailboat", "catamaran", "jetski",
  "speedboat", "fishing_boat", "dinghy", "yacht", "canoe", "kayak", "rowboat", "raft", "log_raft",
  "bicycle", "motorcycle", "bus"]);
export const PERSON_KINDS = new Set(["man", "woman", "child"]);
export const RIDE_KINDS = new Set(["horse", "bicycle", "motorcycle"]);
export const LOW_PROPS = new Set(["crate", "box", "barrel", "rock", "bench", "table", "ac_unit", "stool", "pallet"]);

const ID_RE = /^[a-z0-9_]+$/;
const r3 = (v) => Math.round(v * 1000) / 1000;
const R3 = (a) => a.map(r3);
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const D2R = Math.PI / 180;

/** Rotate p round the vertical axis through c by deg (positive = counter-clockwise seen from above). */
export function yaw(p, c, deg) {
  const a = deg * D2R, x = p[0] - c[0], z = p[2] - c[2];
  return [c[0] + x * Math.cos(a) - z * Math.sin(a), p[1], c[2] + x * Math.sin(a) + z * Math.cos(a)];
}

// ------------------------------------------------------------------------------------------------ the catalog

const HERE = (p) => new URL(p, import.meta.url);

/** One look style (web/look/style_presets.json) as a Looks-tab preset. */
export function styleToPreset(s) {
  return { id: s.id, tab: "look", label: String(s.label || s.id), group: s.group || "Style",
    summary: s.summary || "", words: [String(s.label || "").toLowerCase().replace(/\s*-\s*/g, " ")].filter(Boolean),
    apply: { look: s.id, focal_mm: s.focal_mm || null, grade: s.look?.grade || null, palette: s.look?.palette || null } };
}

/** The whole catalog: presets.json plus the Looks from the style presets. fetchJson(url) can be swapped in tests. */
export async function loadCatalog(fetchJson = null) {
  const get = fetchJson || (async (u) => {
    if (typeof fetch === "function" && !String(u).startsWith("file:")) return (await fetch(u)).json();
    const { readFile } = await import("node:fs/promises");
    return JSON.parse(await readFile(u, "utf8"));
  });
  const [base, styles] = await Promise.all([get(HERE("./presets.json")), get(HERE("../look/style_presets.json")).catch(() => [])]);
  return buildCatalog(base, styles);
}

export function buildCatalog(base, styles = []) {
  const looks = (Array.isArray(styles) ? styles : []).map(styleToPreset);
  const presets = [...(base.presets || []), ...looks];
  return { version: base.version || 1, tabs: base.tabs || [], presets, byId: new Map(presets.map((p) => [p.id, p])) };
}

/** Every problem with a catalog (empty = good). The same rules the Python side checks. */
export function validateCatalog(cat) {
  const errs = [];
  const ids = new Set();
  const tabIds = new Set((cat.tabs || []).map((t) => t.id));
  for (const t of TAB_IDS) if (!tabIds.has(t)) errs.push(`missing tab ${t}`);
  for (const p of cat.presets || []) {
    const at = `preset ${p.id}`;
    if (!p.id || !ID_RE.test(p.id)) errs.push(`${at}: bad id`);
    if (ids.has(p.id)) errs.push(`${at}: duplicate id`);
    ids.add(p.id);
    if (!TAB_IDS.includes(p.tab)) errs.push(`${at}: bad tab ${p.tab}`);
    if (!p.label) errs.push(`${at}: no label`);
    if (p.tab !== "look" && !p.summary) errs.push(`${at}: no summary`);
    const a = p.apply || {};
    if (p.tab === "camera") {
      if (!CAMERA_MOVES.includes(a.camera?.move)) errs.push(`${at}: camera.move ${a.camera?.move}`);
      if (a.rig && !RIG_TYPES.includes(a.rig)) errs.push(`${at}: rig ${a.rig}`);
    } else if (p.tab === "light") {
      if (!TIME_KEYS.includes(a.light?.time)) errs.push(`${at}: light.time ${a.light?.time}`);
      if (!a.light?.setup) errs.push(`${at}: light.setup`);
      if (!a.light?.words) errs.push(`${at}: light.words`);
      for (const k of Object.keys(a.light?.grade || {})) if (!GRADE_KEYS.includes(k)) errs.push(`${at}: grade ${k}`);
    } else if (p.tab === "look") {
      if (!a.look) errs.push(`${at}: look`);
    } else if (p.tab === "action") {
      if (!(STUNT_KINDS.includes(a.stunt) || PHYSICS_KINDS.includes(a.physics) || SHAKE_KINDS.includes(a.shake) || a.mount || SWIM_KINDS.includes(a.swim) || BOAT_KINDS.includes(a.boat))) errs.push(`${at}: no action`);
    } else if (p.tab === "edit") {
      const e = a.edit;
      if (!e) errs.push(`${at}: edit`);
      else {
        if (e.transition != null && !TRANSITION_TYPES.includes(e.transition)) errs.push(`${at}: transition ${e.transition}`);
        if (!["source", "9:16"].includes(e.aspect)) errs.push(`${at}: aspect ${e.aspect}`);
      }
    } else if (p.tab === "recipe") {
      if (!Array.isArray(a.recipe) || !a.recipe.length) errs.push(`${at}: recipe steps`);
      for (const s of a.recipe || []) if (!RECIPE_STEPS.includes(s)) errs.push(`${at}: recipe step ${s}`);
      const gpu = (a.recipe || []).some((s) => /^render_/.test(s));
      if (gpu !== !!a.gpu) errs.push(`${at}: gpu flag must match its render steps`);
    }
  }
  return errs;
}

/** Presets matching a search (label, words, summary, group), best first. Empty query = all of them. */
export function searchPresets(list, q) {
  const t = String(q || "").trim().toLowerCase();
  if (!t) return list.slice();
  const words = t.split(/\s+/);
  const scored = [];
  for (const p of list) {
    const label = String(p.label).toLowerCase(), extra = [...(p.words || []), p.group || "", p.tab].join(" ").toLowerCase();
    const summary = String(p.summary || "").toLowerCase();
    let s = 0;
    for (const w of words) {
      if (label.startsWith(w)) s += 6;
      else if (label.includes(w)) s += 4;
      else if (extra.includes(w)) s += 3;
      else if (summary.includes(w)) s += 1;
      else { s = 0; break; }
    }
    if (s > 0) scored.push([s, p]);
  }
  return scored.sort((a, b) => b[0] - a[0]).map(([, p]) => p);
}

/** Presets named in free text ("make it a crane up at golden hour") -> [{id, at}] in reading order. */
export function presetsInText(list, text) {
  const t = ` ${String(text || "").toLowerCase().replace(/[^a-z0-9:]+/g, " ")} `;
  const hits = [];
  for (const p of list) {
    if (p.tab === "user") continue;
    const names = [p.label, ...(p.words || [])].map((n) => String(n).toLowerCase().replace(/[^a-z0-9:]+/g, " ").trim()).filter((n) => n.length > 2);
    for (const n of names) {
      const i = t.indexOf(` ${n} `);
      if (i >= 0) { hits.push({ id: p.id, at: i, n: n.length }); break; }
    }
  }
  // A longer name wins where two overlap ("film noir" over "noir").
  hits.sort((a, b) => a.at - b.at || b.n - a.n);
  const out = [];
  for (const h of hits) if (!out.some((o) => h.at < o.at + o.n + 1 && o.at < h.at + h.n + 1)) out.push(h);
  return out.map(({ id, at }) => ({ id, at }));
}

// ------------------------------------------------------------------------------------------------ camera moves

/**
 * Camera keys for a move, starting from the shot's first key k0, over frames 0..last. Returns
 * { keys, rig?, follow?: "person"|"vehicle", carView? }. follow moves come back in the followed object's own space.
 */
export function cameraKeys(k0, spec, last = 96) {
  if (!k0?.position || !k0?.target) return null;
  const p = [...k0.position], t = [...k0.target], f0 = +k0.focal_mm || 35;
  const d = sub(t, p), dist = len(d) || 1, n = mul(d, 1 / dist);
  const flat = [n[0], 0, n[2]], fl = Math.hypot(flat[0], flat[2]) || 1, fn = [flat[0] / fl, 0, flat[2] / fl];
  const right = [fn[2], 0, -fn[0]];
  const L = Math.max(1, Math.round(last));
  const key = (frame, pos, tgt, focal = f0) => ({ frame: Math.round(frame), position: R3(pos), target: R3(tgt), focal_mm: r3(focal) });
  const m = spec?.move;
  if (m === "push_in") {
    const go = Math.min(dist * (spec.amount ?? 0.4), Math.max(0, dist - 0.8));
    return { keys: [key(0, p, t), key(L, add(p, mul(n, go)), t)], metres: r3(go) };
  }
  if (m === "pull_out") {
    const go = Math.max(1, dist * (spec.amount ?? 0.6));
    return { keys: [key(0, p, t), key(L, sub(p, mul(n, go)), t)], metres: r3(go) };
  }
  if (m === "orbit") {
    const deg = spec.degrees ?? 60, N = 4;
    return { keys: Array.from({ length: N + 1 }, (_, i) => key((L * i) / N, yaw(p, t, (deg * i) / N), t)), degrees: deg };
  }
  if (m === "crane_up" || m === "crane_down") {
    const h = spec.metres ?? 2.5;
    const low = p, high = [p[0] - fn[0] * h * 0.3, p[1] + h, p[2] - fn[2] * h * 0.3];
    const [a, b] = m === "crane_up" ? [low, high] : [high, low];
    return { keys: [key(0, a, t), key(L, b, t)], metres: h };
  }
  if (m === "dolly_zoom") {
    // Subject size on screen goes with focal / distance: keep it, and the background stretches (Vertigo).
    const d1 = Math.max(1.2, dist * (1 - (spec.amount ?? 0.5)));
    let fa = f0;
    if (fa * d1 / dist < 14) fa = 14 * dist / d1;
    const fb = fa * d1 / dist;
    return { keys: [key(0, p, t, fa), key(L, add(p, mul(n, dist - d1)), t, fb)], focal: [r3(fa), r3(fb)] };
  }
  if (m === "whip_pan") {
    const deg = spec.degrees ?? 75, mid = Math.round(L * 0.5), w = 3;
    const t2 = yaw(t, p, -deg), tm = yaw(t, p, -deg / 2);
    return { keys: [key(0, p, t), key(mid - w, p, t), key(mid, p, tm), key(mid + w, p, t2), key(L, p, t2)], degrees: deg };
  }
  if (m === "follow") {
    // In the person's own space (+Z = where they face): behind the right shoulder, looking where they go.
    const back = spec.metres ?? 2.4;
    return { follow: "person", keys: [key(0, [-0.45, 1.62, -back], [0, 1.4, 3])] };
  }
  if (m === "drone_reveal") {
    const h = spec.metres ?? 8;
    const p1 = [p[0] - fn[0] * h * 0.9, p[1] + h, p[2] - fn[2] * h * 0.9];
    const pm = [p[0] - fn[0] * h * 0.35, p[1] + h * 0.45, p[2] - fn[2] * h * 0.35];
    const t1 = add(t, mul(fn, h * 0.6));
    return { keys: [key(0, p, t), key(L * 0.5, pm, add(t, mul(fn, h * 0.25))), key(L, p1, [t1[0], 0, t1[2]])], metres: h };
  }
  if (m === "tracking_side") {
    const s = spec.metres ?? 4;
    return { keys: [key(0, p, t), key(L, add(p, mul(right, s)), add(t, mul(right, s)))], metres: s };
  }
  if (m === "car_mount") return { follow: "vehicle", carView: spec.view || "windshield", keys: [] };
  if (CAR_PATH_MOVES.includes(m)) return carPathKeys(k0, spec, spec.path, L);
  return null;
}

/** The path sample at a frame (linear between samples; samples are [{frame, position}] in frame order). */
function pathAt(path, f) {
  if (f <= path[0].frame) return path[0].position;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    if (f <= b.frame) { const u = (f - a.frame) / Math.max(1e-6, b.frame - a.frame); return add(a.position, mul(sub(b.position, a.position), u)); }
  }
  return path[path.length - 1].position;
}

/**
 * Racing-cinema camera keys off a vehicle's path (world space). spec: { move: "long_lens_pan" | "arm_car", metres (how
 * far to the side of the path), height (lens height), focal_mm, every (frames between keys), blockers }. path:
 * [{frame, position}] of the car; without one the subject is k0.target, standing still. blockers: the set's solid boxes
 * as [{min, max}] (world AABBs: street facades, the plaza building); the camera never sits inside one or looks through one.
 *   long_lens_pan: a locked-off base `metres` from the path, on the side the shot's camera already is, panning with the
 *     car (a key on it every `every` frames). The base sits opposite the middle of the path's extent and pulls in until
 *     the farthest point of the path is inside PAN_DEPTH_M (the stage's depth guide ends at 40 m: stage.mjs DEPTH_FAR);
 *     the focal length scales with the distance, so the car keeps its size in frame. Real ones sit much further back.
 *   arm_car: a camera car `metres` off the car's side, pacing it (an arm car / U-Crane), lens `height` up; it holds a
 *     fixed side of the path, so it never spins with the car the way a hard mount does.
 * When a set's boxes are in the way, the move flips to the clear side or pulls in to the last clear distance; the
 * result says so (shortened, flipped, wanted) so the toast can.
 */
export const PAN_DEPTH_M = 38;
/** The closest a long-lens pan pulls in for the depth guide (135 mm at 32 m becomes about 50 mm here). */
export const PAN_MIN_M = 12;
export function carPathKeys(k0, spec = {}, path = null, last = 96) {
  if (!k0?.position || !k0?.target) return null;
  const L = Math.max(1, Math.round(last));
  const pts = (Array.isArray(path) && path.length ? path : [{ frame: 0, position: k0.target }])
    .filter((s) => Array.isArray(s?.position) && s.position.length === 3 && s.position.every(Number.isFinite))
    .sort((a, b) => a.frame - b.frame);
  if (!pts.length) return null;
  const pan = spec.move === "long_lens_pan";
  const wanted = Math.max(1, +spec.metres || (pan ? 32 : 5));
  const height = clamp(+spec.height || (pan ? 1.2 : 0.8), 0.1, 6);
  const focal0 = clamp(+spec.focal_mm || (pan ? 135 : 28), 8, 600);
  const every = Math.max(1, Math.round(+spec.every || 6));
  const aim = spec.aim != null && Number.isFinite(+spec.aim) ? clamp(+spec.aim, 0, 3) : 0.6;   // the car's body, not its roof or the road
  const boxes = (Array.isArray(spec.blockers) ? spec.blockers : []).filter((b) => b?.min?.length === 3 && b?.max?.length === 3);
  // The way the car travels: first sample to the one farthest from it (a J-turn comes back along the same line).
  const a = pts[0].position;
  let far = a, best = 0;
  for (const s of pts) { const d = Math.hypot(s.position[0] - a[0], s.position[2] - a[2]); if (d > best) { best = d; far = s.position; } }
  let axis;
  if (best > 0.5) axis = [(far[0] - a[0]) / best, 0, (far[2] - a[2]) / best];
  else {
    // A parked car: across the camera's view. A camera straight above it has no view direction on the ground: any
    // axis (before: a zero axis put the lens on the car, position == target).
    const v = [k0.target[0] - k0.position[0], 0, k0.target[2] - k0.position[2]], n = Math.hypot(v[0], v[2]);
    axis = n > 1e-6 ? [-v[2] / n, 0, v[0] / n] : [1, 0, 0];
  }
  // The middle of the path's extent along its axis (a J-turn's exit can run past its start).
  const us = pts.map((s) => (s.position[0] - a[0]) * axis[0] + (s.position[2] - a[2]) * axis[2]);
  const uc = (Math.min(...us) + Math.max(...us)) / 2;
  const mid = [a[0] + axis[0] * uc, 0, a[2] + axis[2] * uc];
  // The side of the path the shot's camera is on already: the screen direction the shot had stays.
  let pref = [axis[2], 0, -axis[0]];
  if ((k0.position[0] - mid[0]) * pref[0] + (k0.position[2] - mid[2]) * pref[2] < 0) pref = mul(pref, -1);
  const frames = [];
  for (let f = 0; f < L; f += every) frames.push(f);
  frames.push(L);
  const at = (f) => { const p = pathAt(pts, f); return [p[0], (p[1] || 0) + aim, p[2]]; };
  const aims = frames.map(at);
  const flatD = (p, q) => Math.hypot(p[0] - q[0], p[2] - q[2]);
  const place = (side, m) => (pan
    ? frames.map(() => [mid[0] + side[0] * m, height, mid[2] + side[2] * m])
    : frames.map((f) => { const p = pathAt(pts, f); return [p[0] + side[0] * m, (p[1] || 0) + height, p[2] + side[2] * m]; }));
  // Clear = no lens inside a box (0.5 m to spare) and no box between the lens and the car (the last 1.5 m is the car).
  const hit = (p, i) => boxes.some((b) => insideBox(p, b, 0.5) || segmentHitsBox(p, aims[i], b, 1.5));
  const beyond = (poss) => (pan ? poss.filter((p, i) => flatD(p, aims[i]) > PAN_DEPTH_M + 1e-6).length : 0);
  // Every clear distance on both sides, best first: a long-lens pan keeps at least PAN_MIN_M when it can (closer than
  // that it is a wide pan, not a long lens), then the fewest keys past the depth guide, then the most distance, with
  // half a metre's preference for the side the shot's camera is on (its screen direction).
  const minM = pan ? 3 : 1.5, step = 0.25, other = mul(pref, -1);
  const cands = [];
  for (const [sd, isPref] of [[pref, true], [other, false]]) {
    for (let m = wanted; m >= minM - 1e-9; m -= step) {
      const poss = place(sd, m);
      if (boxes.length && poss.some(hit)) continue;
      cands.push({ side: sd, isPref, m, over: beyond(poss), low: pan && m < PAN_MIN_M - 1e-9 });
    }
    if (!boxes.length) break;   // no set in the way: the camera's own side
  }
  cands.sort((x, y) => (x.low - y.low) || (x.over - y.over) || ((y.m + (y.isPref ? 0.5 : 0)) - (x.m + (x.isPref ? 0.5 : 0))));
  let pick = cands[0], blocked = 0;
  if (!pick) {   // nothing on either side is clear: keep the asked-for move and say how many keys the set blocks
    pick = { side: pref, isPref: true, m: wanted, over: beyond(place(pref, wanted)) };
    blocked = place(pref, wanted).filter(hit).length;
  }
  const { side, m } = pick;
  // Why it is shorter: the set (the asked-for distance on the camera's side was blocked) or the depth guide.
  const setForced = boxes.length > 0 && place(pref, wanted).some(hit);
  // A pan pulled in keeps the car's size in frame: the focal length scales with the distance (never below a 24).
  const focal = pan ? clamp(Math.round(focal0 * m / wanted), 24, 600) : focal0;
  const poss = place(side, m);
  const keys = frames.map((f, i) => ({ frame: f, position: R3(poss[i]), target: R3(aims[i]), focal_mm: r3(focal) }));
  const shortened = m < wanted - 1e-6;
  return { keys, metres: m, wanted, focal, world: true, flipped: !pick.isPref, shortened, blocked,
    why: shortened ? (setForced ? "set" : "depth") : null, beyond: pick.over,
    farthest: Math.max(...poss.map((p, i) => flatD(p, aims[i]))) };
}

/** A point inside an axis-aligned box ({min, max}), grown by `pad` metres. */
export function insideBox(p, b, pad = 0) {
  return p[0] > b.min[0] - pad && p[0] < b.max[0] + pad && p[1] > b.min[1] - pad && p[1] < b.max[1] + pad && p[2] > b.min[2] - pad && p[2] < b.max[2] + pad;
}

/** Does the segment p -> q pass through box b (slab test), ignoring its last `skipEnd` metres? */
export function segmentHitsBox(p, q, b, skipEnd = 0) {
  const d = sub(q, p), n = len(d);
  if (n < 1e-6) return insideBox(p, b);
  let t0 = 0, t1 = Math.max(0, 1 - skipEnd / n);
  for (let k = 0; k < 3; k++) {
    if (Math.abs(d[k]) < 1e-9) { if (p[k] <= b.min[k] || p[k] >= b.max[k]) return false; continue; }
    let ta = (b.min[k] - p[k]) / d[k], tb = (b.max[k] - p[k]) / d[k];
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
    if (t0 > t1) return false;
  }
  return true;
}

// ------------------------------------------------------------------------------------------------ lighting

/** A lighting preset as concrete steps: { time|null, setup (from lighting_setups.json)|null, words, grade, weather|null }. */
export function lightingPlan(light, setups = []) {
  const setup = (setups || []).find((s) => s.id === light?.setup) || null;
  const grade = {};
  for (const [k, v] of Object.entries(light?.grade || {})) if (GRADE_KEYS.includes(k)) grade[k] = clamp(+v || 0, -1, 1);
  return { time: light?.time && light.time !== "keep" ? light.time : null, setup, words: String(light?.words || setup?.prompt_words || ""),
    grade, weather: light?.weather && light.weather !== "keep" ? light.weather : null };
}

/** The look patch a preset's grade makes on the current look (absolute values; re-applying never stacks). */
export function gradePatch(currentGrade = {}, grade = {}) {
  return { grade: { ...currentGrade, ...grade } };
}

// ------------------------------------------------------------------------------------------------ action

/** A pyramid of crates (3 · 2 · 1 …) across a path: centre `at`, the path's heading `deg` (0 = +Z). */
/** n names "Base 1", "Base 2"... that skip the ones already taken (QA 2026-11-02: two "Crate 1" in the Outliner). */
export function uniqueNames(base, n, taken = []) {
  const used = new Set((taken || []).map((x) => String(x || "").trim().toLowerCase()));
  const out = [];
  for (let k = 1; out.length < n; k++) {
    const nm = `${base} ${k}`;
    if (!used.has(nm.toLowerCase())) { out.push(nm); used.add(nm.toLowerCase()); }
  }
  return out;
}

export function crateStack(at, deg, n = 6, size = 0.8) {
  const out = [];
  const across = [Math.cos(deg * D2R), 0, -Math.sin(deg * D2R)];   // +X turned with the heading
  let row = 0, left = n;
  let width = 1;
  while (width * (width + 1) / 2 < n) width++;
  while (left > 0) {
    const inRow = Math.min(left, width - row);
    if (inRow <= 0) break;
    for (let i = 0; i < inRow; i++) {
      const off = (i - (inRow - 1) / 2) * (size + 0.02);
      out.push(R3([at[0] + across[0] * off, row * size, at[2] + across[2] * off]));
    }
    left -= inRow;
    row++;
  }
  return out;
}

/** A car's keys driving straight from `start` along heading deg for `metres`, frames 0..last. */
export function driveKeys(start, deg, metres, last) {
  const dir = [Math.sin(deg * D2R), 0, Math.cos(deg * D2R)];
  return [{ frame: 0, position: R3(start) }, { frame: Math.round(last), position: R3(add(start, mul(dir, metres))) }];
}

/** A throw: in the hand at frame 0, let go at `release` moving forward and up (physics takes it from there). */
export function throwKeys(hand, deg, release = 6, { forward = 1.4, up = 0.6 } = {}) {
  const dir = [Math.sin(deg * D2R), 0, Math.cos(deg * D2R)];
  return [{ frame: 0, position: R3(hand) }, { frame: release, position: R3([hand[0] + dir[0] * forward, hand[1] + up, hand[2] + dir[2] * forward]) }];
}

// ------------------------------------------------------------------------------------------------ edit styles

/**
 * An edit style on the saved cut ({cut:[{shot_id, in, out, trans?}], ...}). Pacing trims each clip round its middle
 * to about pacing_s (never longer than it was); transitions go on every `every`th edit; head / tail fades; the
 * style and its render options are kept as edit_style (the Cut's render reads aspect and loudness from it).
 */
export function editStyleCut(saved, edit, { fps = 24, styleId = null } = {}) {
  const s = { ...(saved || {}) };
  const cut = (s.cut || []).map((e) => ({ ...e }));
  const pace = edit?.pacing_s ? Math.max(4, Math.round(edit.pacing_s * fps)) : null;
  for (const e of cut) {
    if (pace && e.out - e.in > pace) {
      const mid = Math.round((e.in + e.out) / 2);
      e.in = Math.max(e.in, mid - Math.floor(pace / 2));
      e.out = e.in + pace;
    }
    delete e.trans;
  }
  const every = Math.max(1, edit?.every || 1);
  if (edit?.transition) {
    const fr = Math.max(1, Math.round((edit.trans_frames || 8) * fps / 24));
    for (let k = 1; k < cut.length; k++) if (k % every === 0) cut[k].trans = { type: edit.transition, frames: fr };
  }
  if (edit?.head && cut.length) cut[0].trans = { type: "dip_black", frames: Math.round(edit.head * fps / 24) };
  s.cut = cut;
  s.fade_out = edit?.tail ? Math.round(edit.tail * fps / 24) : null;
  s.burn_subtitles = !!edit?.subtitles;
  s.edit_style = { id: styleId, aspect: edit?.aspect || "source", loudness: edit?.loudness || null, pacing_s: edit?.pacing_s || null,
    transition: edit?.transition || null, beats: !!edit?.beats, assemble: !!edit?.assemble };
  return s;
}

// ------------------------------------------------------------------------------------------------ user presets

/**
 * A swim path: from `start` ([x, y, z], y = the floor under it) along `headingDeg` at `speed` m/s to the last frame.
 * Under water the diver cruises `lift` m over the floor (the figure's origin; the hips are ~0.95 m higher) with a
 * gentle rise and settle mid-shot (a diver's depth breathes); at the surface the keys sit on the floor and the stage
 * floats them. Returns keys [{frame, position}].
 */
export function swimKeys(start, headingDeg, { speed = 0.5, last = 96, fps = 24, lift = 0.5, surface = false } = {}) {
  const h = headingDeg * D2R, d = speed * last / fps, dir = [Math.sin(h), 0, Math.cos(h)];
  const y = surface ? 0 : start[1] + lift;
  const at = (u, dy = 0) => R3([start[0] + dir[0] * d * u, y + dy, start[2] + dir[2] * d * u]);
  return [{ frame: 0, position: at(0) }, { frame: Math.round(last / 2), position: at(0.5, surface ? 0 : 0.08) }, { frame: last, position: at(1) }];
}

export const USER_KINDS = ["camera", "light", "look"];

/** "Save current as preset": what the current shot / stage / look holds, as a preset of kind camera | light | look. */
export function userPresetFrom(kind, { scene, look }, label, now = Date.now()) {
  if (!USER_KINDS.includes(kind)) throw new Error(`can't save a ${kind} preset`);
  const id = `user_${kind}_${now.toString(36)}`;
  const base = { id, tab: "user", kind, label: String(label || `My ${kind}`).slice(0, 60), summary: "", saved: new Date(now).toISOString() };
  if (kind === "camera") {
    const sh = (scene.shots || []).find((x) => x.id === scene.active_shot) || (scene.shots || [])[0] || {};
    const keys = sh.camera_keys || scene.camera_keys || [];
    const k0 = keys[0];
    if (!k0) throw new Error("this shot has no camera keys to save");
    // Relative to the first key, so it plays from wherever the next shot's camera stands.
    const rel = keys.map((k) => ({ frame: k.frame, d_position: R3(sub(k.position, k0.position)), d_target: R3(sub(k.target, k0.position)),
      focal_mm: k.focal_mm }));
    return { ...base, summary: `${keys.length} camera keys${sh.rig?.type ? ` on a ${sh.rig.type}` : ""}`,
      apply: { user_camera: { keys: rel, rig: sh.rig?.type || null } } };
  }
  if (kind === "light") {
    const L = scene.lighting || {};
    return { ...base, summary: `${L.preset ? L.preset.replace(/_/g, " ") : "manual sun"}${L.lights?.length ? `, ${L.lights.length} lights` : ""}`,
      apply: { user_light: { lighting: JSON.parse(JSON.stringify(L)), sun: scene.sun ? { ...scene.sun } : null } } };
  }
  const lk = JSON.parse(JSON.stringify(look || {}));
  return { ...base, summary: lk.style ? `style ${lk.style.replace(/_/g, " ")}` : "your look and grade", apply: { user_look: lk } };
}

/** A saved camera preset back as keys from the current first key (inverse of userPresetFrom). */
export function userCameraKeys(k0, uc) {
  return (uc?.keys || []).map((k) => ({ frame: k.frame, position: R3(add(k0.position, k.d_position)), target: R3(add(k0.position, k.d_target)),
    focal_mm: k.focal_mm ?? k0.focal_mm }));
}

/** User presets file ({version, presets:[...]}) -> a clean list; bad entries are dropped. */
export function parseUserPresets(json) {
  let j = json;
  if (typeof j === "string") { try { j = JSON.parse(j); } catch { return []; } }
  const list = Array.isArray(j) ? j : j?.presets;
  if (!Array.isArray(list)) return [];
  return list.filter((p) => p && typeof p === "object" && ID_RE.test(p.id || "") && p.tab === "user" && USER_KINDS.includes(p.kind)
    && p.apply && (p.apply.user_camera || p.apply.user_light || p.apply.user_look))
    .map((p) => ({ ...p, label: String(p.label || p.id).slice(0, 60) }));
}

export function userPresetsFile(list) {
  return { version: 1, kind: "soundstage_presets", presets: parseUserPresets({ presets: list }) };
}
