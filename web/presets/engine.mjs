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
  "drone_reveal", "tracking_side", "car_mount"];
export const RIG_TYPES = ["free", "tripod", "dolly", "chapman", "slider", "jib", "steadicam", "handheld", "drone"];
export const TIME_KEYS = ["dawn", "golden_am", "midday", "overcast", "magic_hour", "blue_hour", "night", "keep"];
export const GRADE_KEYS = ["warmth", "contrast", "saturation", "grain", "halation", "vignette"];
export const STUNT_KINDS = ["reverse_jturn", "donut", "handbrake_180"];
export const PHYSICS_KINDS = ["crate_crash", "drop", "throw", "tarp_wind", "rope_bridge", "cardboard_crush", "sand_pile"];   // the last four: soft bodies (Milestone 28)
/** Camera shake on impact (Milestone 21): the shot camera jolts with each baked hit. */
export const SHAKE_KINDS = ["light", "heavy", "earthquake", "off"];
export const RECIPE_STEPS = ["video_to_3d", "new_angle", "ripple_mode", "whole_frame", "quality_draft", "quality_hollywood",
  "render_all_draft", "render_final"];
export const TRANSITION_TYPES = ["dissolve", "dip_black", "dip_white", "wipe"];
export const VEHICLE_KINDS = new Set(["car", "truck", "police_car", "sports_car", "hatchback", "boat", "sailboat", "catamaran", "jetski",
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
      if (!(STUNT_KINDS.includes(a.stunt) || PHYSICS_KINDS.includes(a.physics) || SHAKE_KINDS.includes(a.shake) || a.mount)) errs.push(`${at}: no action`);
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
  return null;
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
