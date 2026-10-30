// Soundstage Coach rules: pure checks over the live scene, the cut and the App state. No DOM, no three.js, so they
// run in node tests. Each rule returns zero or more advice items:
//   {rule, key, level: "error"|"warn"|"tip", icon, title, text, actions: [{label, kind, payload, primary?}]}
// `key` identifies the specific situation (rule + subject) so "Not now" snoozes just that one.
// Action kinds the Coach executes: "ops" (scene ops, undoable through applyOps), "reorder_cut", "trim_shot",
// "set_step", "set_freedom", "open_tab", "describe", "tour_next", "tour_done".
//
// Geometry mirrors web/stage/stage.mjs (Catmull-Rom keys, 36 mm sensor) and soundstage/agent/catalog.py (set
// camera areas, object footprints): metres, Y up, the default camera looks +Z.

const SENSOR_W_MM = 36;
const PEOPLE = new Set(["man", "woman", "child"]);
// [width X, depth Z, height] of library objects at scale 1 (catalog.py LIBRARY).
const FOOT = {
  man: [0.5, 0.35, 1.8], woman: [0.45, 0.3, 1.68], child: [0.35, 0.25, 1.2], dog: [0.3, 0.9, 0.6], horse: [0.6, 2.5, 1.6],
  cat: [0.15, 0.45, 0.3], car: [1.8, 4.5, 1.45], truck: [2.3, 6.5, 2.6], bicycle: [0.5, 1.8, 1.05], motorcycle: [0.6, 1.8, 1.15],
  tree: [1.2, 1.2, 6.5], bush: [1.3, 1.3, 1.1], house: [8, 7, 6], bench: [1.8, 0.5, 0.85], table: [1.4, 0.8, 0.75],
  chair: [0.45, 0.45, 0.9], lamp: [0.3, 0.6, 4.2], rock: [1.4, 1.1, 0.8], crate: [0.8, 0.8, 0.8], wall: [6, 0.25, 2.4], cube: [1, 1, 1],
};
// Where a camera can stand per set: [xmin, xmax, zmin, zmax] (catalog.py CAMERA_AREA); ymin is the floor.
const CAMERA_AREA = {
  interior: [-3.75, 3.75, -16, 4.75], water_tank: [-7.6, 7.6, -7.6, 7.6], street_night: [-6.4, 6.4, -24.5, 34],
  plaza: [-30, 30, -40, 10.2], studio: [-11, 11, -30, 9.6],
};
// Top speeds (m/s) beyond which motion reads as fake: a sprinter peaks ~10, a racehorse ~19.
export const SPEED_LIMITS = { man: 9, woman: 9, child: 7, horse: 20, dog: 15, cat: 13, bicycle: 20, motorcycle: 60, car: 70, truck: 40 };
const WIDE_SETUPS = new Set(["wide", "master", "two_shot", "establishing"]);

// ---------------------------------------------------------------------------------------------- math

const lastFrame = (scene) => Math.max(1, (scene.shot?.frames || 97) - 1);
const fpsOf = (scene) => scene.shot?.fps || 24;

function segment(keys, frame) {
  if (keys.length === 1 || frame <= keys[0].frame) return { i: 0, j: 0, u: 0 };
  const n = keys.length - 1;
  if (frame >= keys[n].frame) return { i: n, j: n, u: 0 };
  let i = 0;
  while (keys[i + 1].frame < frame) i++;
  return { i, j: i + 1, u: (frame - keys[i].frame) / Math.max(1e-6, keys[i + 1].frame - keys[i].frame) };
}

function cr(p0, p1, p2, p3, u) {
  const u2 = u * u, u3 = u2 * u;
  return p1.map((_, k) => 0.5 * ((2 * p1[k]) + (-p0[k] + p2[k]) * u + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * u2
    + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * u3));
}

/** Same interpolation as Stage._sample. */
export function sample(keys, frame, field, ease = true) {
  const { i, j, u } = segment(keys, frame);
  if (i === j) return [...keys[i][field]];
  const n = keys.length - 1;
  let w = u;
  if (ease && n === 1) w = u * u * (3 - 2 * u);
  else if (ease && (i === 0 || j === n)) w = (u * u * (3 - 2 * u) + u) / 2;
  const P = (k) => keys[Math.max(0, Math.min(n, k))][field];
  return cr(P(i - 1), P(i), P(j), P(j + 1), w);
}

export function cameraAt(shot, frame) {
  const keys = shot.camera_keys?.length ? shot.camera_keys : [{ frame: 0, position: [0, 1.7, -8], target: [0, 1.2, 0], focal_mm: 35 }];
  const { i, j, u } = segment(keys, frame);
  const fa = keys[i].focal_mm, fb = keys[j].focal_mm;
  return { position: sample(keys, frame, "position"), target: sample(keys, frame, "target"),
    focal_mm: fa + (fb - fa) * (i === j ? 0 : u * u * (3 - 2 * u)) };
}

export function actorAt(a, frame) {
  const keys = a.keys?.length ? a.keys : [{ frame: 0, position: a.position || [0, 0, 0] }];
  return sample(keys, frame, "position", false);
}

const sub = (a, b) => a.map((x, i) => x - b[i]);
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
const norm = (a) => { const l = Math.hypot(...a) || 1; return a.map((x) => x / l); };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Normalised screen coords (x right, y up, -1..1 at the frame edges), or null if behind the camera. */
export function project(point, cam, aspect) {
  const f = norm(sub(cam.target, cam.position));
  let right = norm(cross(f, [0, 1, 0]));
  if (!Number.isFinite(right[0])) right = [-1, 0, 0];
  const up = cross(right, f);
  const rel = sub(point, cam.position);
  const z = dot(rel, f);
  if (z <= 0.05) return null;
  const halfW = SENSOR_W_MM / 2 / cam.focal_mm;
  const halfH = SENSOR_W_MM / aspect / 2 / cam.focal_mm;
  return [dot(rel, right) / z / halfW, dot(rel, up) / z / halfH];
}

function sizeOf(a) {
  if (a.kind === "custom") {
    const s = a.recipe?.size_m || [1, a.height_m || 1, 1];
    return [s[0], s[2], a.height_m || s[1]];
  }
  const f = FOOT[a.kind] || FOOT.cube;
  const k = ((a.height_m || f[2]) / f[2]) * (a.scale || 1);
  return [f[0] * k, f[1] * k, f[2] * k];
}

/** Axis-aligned footprint {cx, cz, hw, hd, h} at a frame. */
function footprint(a, frame) {
  const [w, d, h] = sizeOf(a);
  const r = ((a.rotation_deg || 0) * Math.PI) / 180;
  const c = Math.abs(Math.cos(r)), s = Math.abs(Math.sin(r));
  const p = actorAt(a, frame);
  return { cx: p[0], cz: p[2], hw: (w * c + d * s) / 2, hd: (w * s + d * c) / 2, h };
}

function aspectOf(ctx) {
  return ctx.aspect || 960 / 512;
}

function shotsInCut(ctx) {
  const shots = ctx.scene.shots || [];
  const byId = new Map(shots.map((s) => [s.id, s]));
  const cut = ctx.cut?.cut || [];
  const order = cut.map((e) => byId.get(String(e.shot_id))).filter(Boolean);
  return order.length ? order : shots;
}

const people = (scene) => (scene.actors || []).filter((a) => PEOPLE.has(a.kind));
const nameOf = (a) => a.name || a.kind || a.id;
const r3 = (v) => v.map((x) => Math.round(x * 1000) / 1000);

// ---------------------------------------------------------------------------------------------- rules

/** Shots in the cut out of story order (the Advisor's shot numbers, or a close-up before any wide). */
export function storyOrder(ctx) {
  const order = shotsInCut(ctx);
  if (!ctx.cut?.cut?.length || order.length < 2) return [];
  const tagged = order.filter((s) => s.advisor?.shot != null);
  if (tagged.length >= 2) {
    const nums = tagged.map((s) => Number(s.advisor.shot));
    const sorted = [...nums].sort((a, b) => a - b);
    if (nums.some((n, i) => n !== sorted[i])) {
      const want = [...tagged].sort((a, b) => a.advisor.shot - b.advisor.shot).map((s) => s.id);
      const rest = order.filter((s) => s.advisor?.shot == null).map((s) => s.id);
      return [{ rule: "story_order", key: `story_order:${nums.join(",")}`, level: "warn", icon: "film",
        title: "Shots out of story order?",
        text: `The Advisor planned these as ${sorted.join(" → ")}, but the cut plays them ${nums.join(" → ")}. ` +
          "Check the order before you render.",
        actions: [{ label: "Reorder", kind: "reorder_cut", payload: { order: [...want, ...rest] }, primary: true }] }];
    }
  }
  const firstWide = order.findIndex((s) => WIDE_SETUPS.has(s.setup));
  const tight = order.findIndex((s) => /^(single|ots|insert|pov)/.test(s.setup || ""));
  if (people(ctx.scene).length >= 2 && tight === 0 && firstWide > 0) {
    const ids = order.map((s) => s.id);
    const [w] = ids.splice(firstWide, 1);
    return [{ rule: "story_order", key: `geography:${order[0].id}`, level: "tip", icon: "film",
      title: "Open on the wide?",
      text: `The cut starts on a close shot (${order[0].name}). Showing the wide first tells the audience where everyone is.`,
      actions: [{ label: "Move the wide first", kind: "reorder_cut", payload: { order: [w, ...ids] }, primary: true }] }];
  }
  return [];
}

function badCamera(ctx, cam) {
  const set = ctx.scene.environment?.set || "plaza";
  const p = cam.position;
  if (p[1] < 0.08) return "below the floor";
  const area = CAMERA_AREA[set];
  if (area && (p[0] < area[0] || p[0] > area[1] || p[2] < area[2] || p[2] > area[3])) {
    return set === "interior" ? "outside the room walls" : set === "water_tank" ? "outside the tank" : "inside the set's buildings";
  }
  return null;
}

function insideObject(ctx, cam, frame) {
  for (const a of ctx.scene.actors || []) {
    if (a.mount_id) continue;
    const fp = footprint(a, frame);
    const p = cam.position;
    if (Math.abs(p[0] - fp.cx) < fp.hw && Math.abs(p[2] - fp.cz) < fp.hd && p[1] < fp.h) return a;
  }
  return null;
}

/** Move a camera out of trouble: back along its view line (or toward its target), keeping the framing. */
export function fixCamera(ctx, key, frame) {
  const area = CAMERA_AREA[ctx.scene.environment?.set] || [-60, 60, -60, 60];
  const ok = (p) => p[1] >= 0.15 && p[0] >= area[0] && p[0] <= area[1] && p[2] >= area[2] && p[2] <= area[3]
    && !insideObject(ctx, { position: p }, frame);
  const t = key.target, p0 = [...key.position];
  p0[1] = Math.max(p0[1], 0.15);
  const d0 = Math.hypot(...sub(p0, t)) || 1;
  for (const s of [1, 1.15, 1.3, 1.5, 0.85, 0.7, 0.55, 0.4, 0.25]) {
    const p = t.map((x, i) => x + (p0[i] - x) * s);
    if (ok(p)) {
      const d = Math.hypot(...sub(p, t));
      return { ...key, position: r3(p), focal_mm: Math.round(key.focal_mm * (d / d0) * 10) / 10 };
    }
  }
  return { ...key, position: r3([Math.min(Math.max(p0[0], area[0]), area[1]), p0[1], Math.min(Math.max(p0[2], area[2]), area[3])]) };
}

/** Camera inside a wall, under the floor or inside an object, at any point of the shot. */
export function cameraClipping(ctx) {
  const out = [];
  for (const shot of ctx.scene.shots || []) {
    const last = lastFrame(ctx.scene);
    for (let f = 0; f <= last; f += 8) {
      const cam = cameraAt(shot, f);
      const why = badCamera(ctx, cam) || (insideObject(ctx, cam, f) ? `inside ${nameOf(insideObject(ctx, cam, f))}` : null);
      if (!why) continue;
      const keys = shot.camera_keys.map((k) => (badCamera(ctx, k) || insideObject(ctx, k, k.frame) ? fixCamera(ctx, k, k.frame) : k));
      const changed = JSON.stringify(keys) !== JSON.stringify(shot.camera_keys);
      out.push({ rule: "camera_clip", key: `camera_clip:${shot.id}`, level: "error", icon: "camera",
        title: "Camera goes through the set",
        text: `In “${shot.name}” the camera is ${why} at ${(f / fpsOf(ctx.scene)).toFixed(1)} s. The render will show the inside of things.`,
        actions: changed ? [{ label: "Move it out", kind: "ops", primary: true, payload: [{ op: "update_shot", id: shot.id,
          set: { camera_keys: keys }, undo: { op: "update_shot", id: shot.id, set: { camera_keys: shot.camera_keys } } }] }] : [] });
      break;
    }
  }
  return out;
}

/** People leaving frame before the cut ends, or the subject too small to read in a non-wide shot. */
export function framing(ctx) {
  const out = [];
  const aspect = aspectOf(ctx);
  const cast = people(ctx.scene);
  if (!cast.length) return out;
  const cutEntries = new Map((ctx.cut?.cut || []).map((e) => [String(e.shot_id), e]));
  const last = lastFrame(ctx.scene);
  for (const shot of ctx.scene.shots || []) {
    if (ctx.cut?.cut?.length && !cutEntries.has(shot.id)) continue;
    const entry = cutEntries.get(shot.id);
    const outF = Math.min(last, entry?.out ?? last);
    const vis = (a, f) => {
      const cam = cameraAt(shot, f);
      const p = actorAt(a, f), h = sizeOf(a)[2];
      const feet = project([p[0], 0.1, p[2]], cam, aspect), head = project([p[0], h * 0.95, p[2]], cam, aspect);
      if (!feet || !head) return { in: false, area: 0 };
      const inside = (q) => Math.abs(q[0]) <= 1.02 && Math.abs(q[1]) <= 1.02;
      const hf = Math.abs(head[1] - feet[1]) / 2;
      return { in: inside(feet) || inside(head), area: 0.28 * hf * hf / aspect };
    };
    // Leaves frame: in at the first frame, out for the last stretch the cut still shows.
    for (const a of cast) {
      if (!vis(a, entry?.in ?? 0).in) continue;
      let leftAt = null;
      for (let f = entry?.in ?? 0; f <= outF; f += 4) {
        const v = vis(a, f).in;
        if (!v && leftAt === null) leftAt = f;
        if (v) leftAt = null;
      }
      if (leftAt !== null && outF - leftAt >= Math.max(12, 0.2 * (outF - (entry?.in ?? 0)))) {
        const trimTo = Math.min(outF, leftAt + 6);
        out.push({ rule: "leaves_frame", key: `leaves_frame:${shot.id}:${a.id}`, level: "warn", icon: "eye",
          title: `${nameOf(a)} leaves frame early`,
          text: `In “${shot.name}”, ${nameOf(a)} is out of frame from ${(leftAt / fpsOf(ctx.scene)).toFixed(1)} s, but the shot ` +
            `runs to ${(outF / fpsOf(ctx.scene)).toFixed(1)} s. Trim it, or pan to follow.`,
          actions: entry ? [{ label: "Trim the shot", kind: "trim_shot", payload: { shot_id: shot.id, out: trimTo }, primary: true }] : [] });
        break;
      }
    }
    // Subject too small in a shot that is meant to be close.
    if (!WIDE_SETUPS.has(shot.setup) && /^(single|ots|insert|pov)/.test(shot.setup || "")) {
      const frames = [];
      for (let f = entry?.in ?? 0; f <= outF; f += 8) frames.push(f);
      const best = Math.max(...cast.map((a) => Math.max(...frames.map((f) => vis(a, f).area))));
      if (best < 0.03) {
        out.push({ rule: "tiny_subject", key: `tiny_subject:${shot.id}`, level: "warn", icon: "maximize-2",
          title: "Subject is tiny",
          text: `“${shot.name}” is set up as a ${shot.setup.replace("_", " ")}, but nobody fills more than ` +
            `${(best * 100).toFixed(1)}% of the frame. Push in or use a longer lens.`,
          actions: [{ label: "Push in", kind: "ops", primary: true, payload: [pushIn(shot)] }] });
      }
    }
  }
  return out;
}

function pushIn(shot) {
  const keys = shot.camera_keys.map((k) => ({ ...k, focal_mm: Math.min(200, Math.round(k.focal_mm * 1.8)) }));
  return { op: "update_shot", id: shot.id, set: { camera_keys: keys }, undo: { op: "update_shot", id: shot.id, set: { camera_keys: shot.camera_keys } } };
}

/** 180° line: consecutive shots in the cut on opposite sides of the A-B line. */
export function lineCrossing(ctx) {
  const cast = people(ctx.scene);
  const order = shotsInCut(ctx);
  if (cast.length < 2 || order.length < 2) return [];
  const A = actorAt(cast[0], 0), B = actorAt(cast[1], 0);
  const axis = norm([B[0] - A[0], 0, B[2] - A[2]]);
  const n = [-axis[2], 0, axis[0]];
  const side = (shot) => {
    const keys = shot.camera_keys || [];
    if (keys.length > 1 && Math.sign(dot(sub(keys[0].position, A), n)) !== Math.sign(dot(sub(keys.at(-1).position, A), n))) return "moving";
    const d = dot(sub(cameraAt(shot, 0).position, A), n);
    return Math.abs(d) < 0.3 ? "on" : d > 0 ? "L" : "R";
  };
  for (let i = 1; i < order.length; i++) {
    const a = side(order[i - 1]), b = side(order[i]);
    if (["on", "moving"].includes(a) || ["on", "moving"].includes(b) || a === b) continue;
    const shot = order[i];
    const mirror = (p) => { const d = dot(sub(p, A), n); return r3(p.map((x, k) => x - 2 * d * n[k])); };
    const keys = shot.camera_keys.map((k) => ({ ...k, position: mirror(k.position), target: mirror(k.target) }));
    return [{ rule: "line_crossing", key: `line_crossing:${order[i - 1].id}:${shot.id}`, level: "warn", icon: "move-3d",
      title: "Crosses the 180° line",
      text: `“${shot.name}” is on the other side of the ${nameOf(cast[0])}–${nameOf(cast[1])} line from “${order[i - 1].name}”. ` +
        "Their eyelines will flip on the cut.",
      actions: [{ label: "Mirror the camera", kind: "ops", primary: true, payload: [{ op: "update_shot", id: shot.id,
        set: { camera_keys: keys }, undo: { op: "update_shot", id: shot.id, set: { camera_keys: shot.camera_keys } } }] }] }];
  }
  return [];
}

/** Motion faster than the thing could really move. */
export function tooFast(ctx) {
  const out = [];
  const fps = fpsOf(ctx.scene), last = lastFrame(ctx.scene);
  for (const a of ctx.scene.actors || []) {
    const limit = SPEED_LIMITS[a.kind];
    const keys = a.keys || [];
    if (!limit || a.mount_id || keys.length < 2) continue;
    let worst = 0;
    for (let i = 1; i < keys.length; i++) {
      const dt = (keys[i].frame - keys[i - 1].frame) / fps;
      const dist = Math.hypot(keys[i].position[0] - keys[i - 1].position[0], keys[i].position[2] - keys[i - 1].position[2]);
      if (dt > 0) worst = Math.max(worst, dist / dt);
    }
    if (worst <= limit) continue;
    const factor = worst / (limit * 0.9);
    const f0 = keys[0].frame;
    let fixed;
    if (f0 + (keys.at(-1).frame - f0) * factor <= last) {
      fixed = keys.map((k) => ({ frame: Math.round(f0 + (k.frame - f0) * factor), position: k.position }));   // take longer
    } else {
      const p0 = keys[0].position;
      fixed = keys.map((k) => ({ frame: k.frame, position: r3(k.position.map((x, i) => p0[i] + (x - p0[i]) / factor)) }));  // go less far
    }
    out.push({ rule: "too_fast", key: `too_fast:${a.id}:${Math.round(worst)}`, level: "warn", icon: "sliders-horizontal",
      title: `${nameOf(a)} moves too fast`,
      text: `${nameOf(a)} hits ${worst.toFixed(1)} m/s (${(worst * 3.6).toFixed(0)} km/h); a real ${a.kind} tops out near ${limit} m/s. ` +
        "The video model will smear or skate it.",
      actions: [{ label: "Slow down", kind: "ops", primary: true, payload: [{ op: "update_object", id: a.id,
        set: { keys: fixed, position: fixed[0].position }, undo: { op: "update_object", id: a.id, set: { keys: a.keys, position: a.position } } }] }] });
  }
  return out;
}

/** Big animals and vehicles can't spin on the spot: one that must turn > 90° as it sets off should start facing that way. */
const TURNERS = new Set(["horse", "cow", "car", "police_car", "sports_car", "hatchback", "truck", "bus", "motorcycle", "bicycle"]);
export function suddenTurn(ctx) {
  const out = [];
  for (const a of ctx.scene.actors || []) {
    const keys = a.keys || [];
    if (!TURNERS.has(a.kind) || a.mount_id || keys.length < 2) continue;
    const i = keys.findIndex((k, j) => j > 0 && Math.hypot(k.position[0] - keys[j - 1].position[0], k.position[2] - keys[j - 1].position[2]) > 0.05);
    if (i < 1) continue;
    const dx = keys[i].position[0] - keys[i - 1].position[0], dz = keys[i].position[2] - keys[i - 1].position[2];
    const go = Math.atan2(dx, dz) * 180 / Math.PI;
    const turn = Math.abs(((go - (a.rotation_deg || 0) + 540) % 360) - 180);
    if (turn <= 90) continue;
    const face = Math.round(go);
    out.push({ rule: "sudden_turn", key: `sudden_turn:${a.id}:${face}:${a.rotation_deg || 0}`, level: "warn", icon: "rotate-ccw",
      title: `${nameOf(a)} has to turn around`,
      text: `${nameOf(a)} starts facing one way and sets off ${Math.round(turn)}° the other way. A real ${a.kind} needs time to turn ` +
        "(it now pivots in place first). Usually it should already face the way it will go, from the first frame.",
      actions: [{ label: "Face the way they'll go", kind: "ops", primary: true, payload: [{ op: "update_object", id: a.id,
        set: { rotation_deg: face }, undo: { op: "update_object", id: a.id, set: { rotation_deg: a.rotation_deg || 0 } } }] }] });
  }
  return out;
}

/** The stage changed since the last final render / the step is up the ladder after edits. */
export function staleRender(ctx) {
  if (ctx.step > 1 && ctx.finalHash && ctx.sceneHash !== ctx.finalHash) {
    return [{ rule: "stale_render", key: `stale_render:${ctx.sceneHash}`, level: "tip", icon: "rotate-ccw",
      title: "Preview first?",
      text: "You changed the stage since the last final render. Run step 1 (the clay preview) to check it before " +
        "spending a full render.",
      actions: [{ label: "Go to step 1", kind: "set_step", payload: { step: 1 }, primary: true }] }];
  }
  if (ctx.step > 1 && ctx.editedSinceRun && !ctx.finalHash) {
    return [{ rule: "step_high", key: `step_high:${ctx.step}:${ctx.sceneHash}`, level: "tip", icon: "rotate-ccw",
      title: `Step is at ${ctx.step}`,
      text: `Running now renders everything up to step ${ctx.step}. After an edit it is quicker to preview at step 1 first.`,
      actions: [{ label: "Go to step 1", kind: "set_step", payload: { step: 1 }, primary: true }] }];
  }
  return [];
}

/** Motion freedom high: a very soft guide can drift the composition (the blur reaches ~16 px at 1.0). */
export function motionFreedom(ctx) {
  if (!(ctx.motionFreedom >= 0.8)) return [];
  return [{ rule: "motion_freedom", key: "motion_freedom", level: "tip", icon: "sparkles", title: "Very loose guide",
    text: `Motion freedom ${ctx.motionFreedom.toFixed(2)} softens the previz a lot: motion gets more natural, but framing and ` +
      "positions can drift. 0.3–0.6 keeps the composition for animals and action.",
    actions: [{ label: "Set to 0.5", kind: "set_freedom", payload: { value: 0.5 }, primary: true }] }];
}

/** Who is on stage, by name and kind: what a written scene description is about. */
export function castSig(scene) {
  return (scene?.actors || []).map((a) => `${a.kind}:${a.name || ""}`).sort().join("|");
}

/** The Look's scene description was written for a different cast: LTX follows the text and invents people. */
export function staleDescription(ctx) {
  const d = (ctx.lookDescription || "").trim();
  if (!d || !(ctx.scene.actors || []).length || ctx.lookDescCast === castSig(ctx.scene)) return [];
  const quote = d.length > 110 ? `${d.slice(0, 107)}…` : d;
  return [{ rule: "stale_description", key: `stale_description:${castSig(ctx.scene)}`, level: "warn", icon: "message-square",
    title: "Scene description is from another scene",
    text: `The Look still says “${quote}”. The render follows that text, so it can add people or actions your stage ` +
      "doesn't have. Clear it (the stage describes itself), or keep it if it still fits.",
    actions: [{ label: "Clear it", kind: "clear_description", payload: {}, primary: true },
      { label: "It still fits", kind: "keep_description", payload: {} }] }];
}

/** No Look picked: the render falls back to a generic style. */
export function noLook(ctx) {
  if (ctx.lookPicked !== false || !(ctx.scene.actors || []).length) return [];
  return [{ rule: "no_look", key: "no_look", level: "tip", icon: "palette", title: "Pick a look",
    text: "No camera, lens or film stock is set, so the render gets a generic style. The Look tab sets the photography in a few clicks.",
    actions: [{ label: "Open Look", kind: "open_tab", payload: { tab: "look" }, primary: true }] }];
}

/** Nothing on stage yet. */
export function emptyScene(ctx) {
  if ((ctx.scene.actors || []).length) return [];
  return [{ rule: "empty_scene", key: "empty_scene", level: "tip", icon: "wand-sparkles", title: "Start with a sentence",
    text: "The stage is empty. Describe the scene (“two gunfighters face off at noon”) and it builds the set, cast and cameras, " +
      "or ask the Director's Advisor for a shot list.",
    actions: [{ label: "Describe the scene", kind: "describe", payload: {}, primary: true },
      { label: "Open Advisor", kind: "open_tab", payload: { tab: "advisor" } }] }];
}

export const TOUR = [
  { icon: "move-3d", title: "Move around the set", text: "Drag to orbit, scroll to dolly in and out, Shift-drag to pan. " +
      "What you see is exactly what the camera films." },
  { icon: "plus", title: "Add things", text: "Type a word in the Add box (horse, car, bench), or describe the whole scene " +
      "in one sentence and let it build the set." },
  { icon: "diamond", title: "Set keys", text: "Move the playhead, then drag an actor or the camera: a ◆ key is set there " +
      "automatically. Two keys make a move." },
  { icon: "play", title: "Run up the ladder", text: "Run renders step 1 (clay preview). NEXT climbs: look still, motion " +
      "draft, final. Check each step before paying for the next." },
];

/** First-run guided tips, one at a time. */
export function tour(ctx) {
  const i = ctx.tourStep ?? TOUR.length;
  if (i >= TOUR.length) return [];
  const t = TOUR[i];
  return [{ rule: "tour", key: `tour:${i}`, level: "tour", icon: t.icon, title: `${t.title} (${i + 1}/${TOUR.length})`, text: t.text,
    actions: [{ label: i < TOUR.length - 1 ? "Next" : "Got it", kind: i < TOUR.length - 1 ? "tour_next" : "tour_done", payload: {}, primary: true },
      { label: "Skip tips", kind: "tour_done", payload: {} }] }];
}

// Which rules run on which event. "run" is just before a job is queued.
export const RULES = {
  stage: [cameraClipping, tooFast, suddenTurn, motionFreedom, staleRender, emptyScene, tour],
  shots: [cameraClipping, framing, lineCrossing, storyOrder, tour],
  tab: [noLook, emptyScene, staleDescription],
  open: [tour, emptyScene, motionFreedom, staleDescription],
  run: [staleDescription, suddenTurn, storyOrder, lineCrossing, cameraClipping, framing, tooFast, motionFreedom, staleRender, noLook],
};
export const LEVEL_RANK = { error: 0, warn: 1, tour: 2, tip: 3 };

/** All advice for an event, most important first. */
export function advise(event, ctx) {
  const items = [];
  for (const rule of RULES[event] || RULES.stage) {
    try { items.push(...rule(ctx)); } catch { /* a broken rule never breaks the stage */ }
  }
  const seen = new Set();
  return items.filter((x) => !seen.has(x.key) && seen.add(x.key)).sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level]);
}

/** Stable hash of what a render depends on (ignores the derived per-frame camera track and the active shot). */
export function sceneHash(scene) {
  const { camera_track: _t, active_shot: _a, ...rest } = scene || {};
  const s = JSON.stringify(rest);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}
