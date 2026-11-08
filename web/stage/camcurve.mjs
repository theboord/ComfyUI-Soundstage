// Smooth camera curve (curve version 2): the shot camera's path through its keys without speed jumps at the keys.
// Pure maths, no three.js: the stage (stage.mjs _cameraAt), the Coach (coach/rules.mjs cameraAt) and the key fitter
// (movefit/stabilize.mjs reduceKeys) all play camera keys through this one copy.
//
// Version 1 (the old curve, kept for shots saved before this change): uniform Catmull-Rom per segment, so a key's
// tangent ignores how long each side takes (a key between a 12-frame and a 36-frame segment jumps speed about 3x),
// easing that halves the speed at the first and last interior keys, and the focal length smoothstepped per segment
// (its zoom rate drops to zero at every key). A shot plays version 2 when shot.cam_curve === 2; a shot with no
// cam_curve plays version 1, so shots saved before this change don't move. What gets version 2:
//   - a new node's and a fresh scene's Master, new car shots, the scene agent's new shots (soundstage.js
//     markNewShots after a build or an edit that adds shots; the Python agent itself writes no version);
//   - any new move handed to Stage.setCameraKeys (presets, Advisor setups, phone / VCam takes, rig snaps, Cut setups
//     framed from a preset), except a COPY of a shot still on version 1 (the Cut's copy / duplicate setup);
//   - a shot whose camera is re-keyed on the stage (a key added, moved by orbiting the shot camera, or deleted).
// A new setup from the stage's own "+ setup" copies the curve of the shot it starts from.
//
// Version 2, per field (position, target: per component; focal: in log space, so a 24 -> 48 -> 96 mm zoom feels even):
//   - cubic Hermite through every key at its frame, tangents from the key TIMES (the three-point derivative weighted by
//     the two segment lengths): velocity is continuous across every key, whatever the spacing;
//   - an overshoot limiter (see tangents): a component that turns back at a key stops there and its neighbours are
//     held to 3x that segment's slope, so no axis swings past a key where it turns back, whatever the key spacing;
//     an axis level between two keys may bulge past them by at most the arc the turn implies (an orbit's arc);
//   - zero-velocity tangents at hold boundaries (two keys with the same value): the hold is truly still and the move
//     out of it starts from rest, never bowing backwards first;
//   - easing only at the shot's first and last keys (zero tangents there): interior keys never stall;
//   - optional even speed (shot.cam_speed === "even"): the same path re-timed by arc length (the camera's and its
//     target's travel combined) so it travels at one speed between a short ease-in and ease-out (interior key times
//     and holds are then ignored, by choice; lens_keys focus / iris stay on frame time).

export const CAM_CURVE = 2;                    // the version new and re-keyed shots carry (shot.cam_curve; see above)
export const EVEN_RAMP = 0.2;                  // even speed: ease-in / ease-out, as a share of the move each end
export const ARC_DIVISIONS = 2048;             // even speed: samples of the path for its arc length

/** The curve version a shot plays: 2 when marked, else 1 (the old curve). */
export const curveVersion = (shot) => (shot && shot.cam_curve === CAM_CURVE ? CAM_CURVE : 1);

/** New shots (ids not in `known`) without a curve version go onto the smooth curve: a scene the scene agent just built,
 *  shots its edits added. Shots already known (saved before version 2) are left alone. Mutates; returns how many. */
export function markNewShots(scene, known = new Set()) {
  let n = 0;
  for (const sh of scene?.shots || []) if (sh && !known.has(sh.id) && sh.cam_curve == null) { sh.cam_curve = CAM_CURVE; n++; }
  return n;
}

const sameVal = (a, b) => a.every((x, k) => Math.abs(x - b[k]) < 1e-4);

/** Hermite tangents (value per frame) for values v[] at frames t[]. Ends 0 (ease out of the first key, into the last). */
export function tangents(t, v) {
  const n = v.length - 1, D = v[0].length;
  const m = v.map(() => new Array(D).fill(0));
  const turn = v.map(() => 0);   // the angle between the two chords at each key (radians; 0 at the ends and holds)
  for (let i = 1; i < n; i++) {
    if (sameVal(v[i - 1], v[i]) || sameVal(v[i], v[i + 1])) continue;   // a hold boundary: from / to rest
    const h0 = Math.max(1e-6, t[i] - t[i - 1]), h1 = Math.max(1e-6, t[i + 1] - t[i]);
    const d0 = v[i].map((x, c) => (x - v[i - 1][c]) / h0), d1 = v[i + 1].map((x, c) => (x - v[i][c]) / h1);
    const mc = d0.map((x, c) => (x * h1 + d1[c] * h0) / (h0 + h1));    // the derivative from the key times
    // Per axis (Fritsch-Carlson): an axis that turns back here (or is flat on one side) stops, one that keeps going is
    // held to 3x its slower side. Right where the PATH turns back (out and back, a sharp corner); on a gently curving
    // path it zeroed an axis at its extremum (an orbit's z where the neighbouring keys share a value), so the camera
    // slowed at those keys. So the limit follows the path's turn: up to 60 degrees between the two chords, the whole
    // tangent is limited as a vector (3x the slower side's speed) and lengthened from chord to arc (theta / sin theta,
    // exact for keys evenly spaced on a circle); past 90 degrees, per axis; blended in between.
    const n0 = Math.hypot(...d0), n1 = Math.hypot(...d1);
    const cos = n0 > 1e-12 && n1 > 1e-12 ? d0.reduce((s, x, c) => s + x * d1[c], 0) / (n0 * n1) : -1;
    const w = Math.max(0, Math.min(1, cos / 0.5));
    turn[i] = Math.acos(Math.max(-1, Math.min(1, cos)));
    const axis = mc.map((x, c) => {
      if (d0[c] * d1[c] <= 0) return 0;
      const lim = 3 * Math.min(Math.abs(d0[c]), Math.abs(d1[c]));
      return Math.abs(x) > lim ? Math.sign(x) * lim : x;
    });
    let vec = mc;
    if (w > 0) {
      const th = Math.acos(Math.max(-1, Math.min(1, cos)));
      const arc = th > 1e-6 ? th / Math.sin(th) : 1;
      const nm = Math.hypot(...mc) * arc, lim = 3 * Math.min(n0, n1);
      const s = nm > 1e-12 ? Math.min(nm, lim) / Math.hypot(...mc) : 0;
      vec = mc.map((x) => x * s);
    }
    // An axis that strictly turns back at this key (its secant changes sign) stops here whatever the turn: the vector
    // limit kept the time-weighted derivative's component, which is not zero when the two sides take different times,
    // so an uneven-spaced gentle turn swung past its key on that axis (a 50 deg turn at 12 / 36 frames: 16 cm). With
    // even spacing that component is already zero, so evenly keyed turns and orbits are unchanged. An axis flat on one
    // side (an orbit's z between two keys at the same height) keeps its tangent: that hump is the arc, not a swing.
    const eps = 1e-9 * (n0 + n1);   // a side flat to rounding (sin 72 vs sin 108) is flat, not a turn-back
    const back = (c) => Math.abs(d0[c]) > eps && Math.abs(d1[c]) > eps && d0[c] * d1[c] < 0;
    for (let c = 0; c < D; c++) m[i][c] = back(c) ? 0 : w * vec[c] + (1 - w) * axis[c];
  }
  // Per segment and axis (Fritsch-Carlson with one end at rest): next to a key where the axis stops (a turn-back, a
  // hold, the shot's ends), the other end's tangent is held to 3x the segment's own slope on that axis, or the
  // segment swings past the stopping key (the vector limit bounds the tangent's length, not each axis).
  for (let i = 0; i < n; i++) {
    const h = Math.max(1e-6, t[i + 1] - t[i]);
    for (let c = 0; c < D; c++) {
      const d = (v[i + 1][c] - v[i][c]) / h;
      if (Math.abs(d) < 1e-9) {
        // Flat on this axis (both keys at the same height, say): any tangent here bulges the segment past both keys.
        // On an orbit that bulge is the arc (z between keys at 72 and 108 deg), so it is kept, but held to the
        // sagitta of an arc over the chord that turns as much as its sharper key (chord / 2 x tan(turn / 4)): an L
        // move (up a diagonal, then level) bulged 37 cm past its level keys, now about 20 cm, the arc it implies.
        const L = Math.hypot(...v[i + 1].map((x, k) => x - v[i][k]));
        const B = (L / 2) * Math.tan(Math.min(Math.PI / 2, Math.max(turn[i], turn[i + 1])) / 4);
        let hump = 0;
        for (let s = 1; s < 32; s++) {
          const u = s / 32, u2 = u * u, u3 = u2 * u;
          hump = Math.max(hump, Math.abs(h * (m[i][c] * (u3 - 2 * u2 + u) + m[i + 1][c] * (u3 - u2))));
        }
        if (hump > B + 1e-9) { const k = B / hump; m[i][c] *= k; m[i + 1][c] *= k; }
        continue;
      }
      for (const [a, b] of [[i, i + 1], [i + 1, i]]) {
        if (m[b][c] !== 0) continue;
        if (m[a][c] * d < 0) m[a][c] = 0;
        else if (Math.abs(m[a][c]) > 3 * Math.abs(d)) m[a][c] = 3 * d;
      }
    }
  }
  return m;
}

/** The segment holding frame and its 0..1 progress (as Stage._segment). */
function segment(t, frame) {
  const n = t.length - 1;
  if (n < 1 || frame <= t[0]) return { i: 0, j: 0, u: 0 };
  if (frame >= t[n]) return { i: n, j: n, u: 0 };
  let lo = 0, hi = n;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (t[mid] < frame) lo = mid; else hi = mid; }
  if (t[hi] === frame) return { i: hi, j: hi + 1, u: 0 };   // exactly on an interior key: its own segment, at its start
  return { i: lo, j: lo + 1, u: (frame - t[lo]) / Math.max(1e-6, t[lo + 1] - t[lo]) };
}

/** One field's curve: {t, v, m} -> value at frame. */
function hermiteAt(c, frame) {
  const { i, j, u } = segment(c.t, frame);
  if (i === j) return [...c.v[i]];
  const a = c.v[i], b = c.v[j];
  if (sameVal(a, b)) return [...a];
  const h = c.t[j] - c.t[i], u2 = u * u, u3 = u2 * u;
  const h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
  return a.map((x, k) => h00 * x + h10 * h * c.m[i][k] + h01 * b[k] + h11 * h * c.m[j][k]);
}

/** Hermite basis weights of each key's VALUE at frame, for the linear part (no limiter, no holds): stabilize's
 *  least-squares fitter. Tangents are the time-weighted three-point derivative, ends zero. Returns [[key, weight]]. */
export function linearWeights(t, frame) {
  const { i, j, u } = segment(t, frame);
  if (i === j) return [[i, 1]];
  const n = t.length - 1, h = t[j] - t[i], u2 = u * u, u3 = u2 * u;
  const h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
  const W = new Map();
  const add = (k, w) => { if (w) W.set(k, (W.get(k) || 0) + w); };
  // tangent at key q as weights of the values: m_q = (d0 h1 + d1 h0) / (h0 + h1), d0 = (v_q - v_{q-1}) / h0, ...
  const tan = (q, s) => {
    if (q <= 0 || q >= n) return;
    const h0 = t[q] - t[q - 1], h1 = t[q + 1] - t[q], H = h0 + h1;
    add(q - 1, -s * (h1 / h0) / H); add(q, s * ((h1 / h0) - (h0 / h1)) / H); add(q + 1, s * (h0 / h1) / H);
  };
  add(i, h00); add(j, h01);
  tan(i, h10 * h); tan(j, h11 * h);
  return [...W.entries()];
}

const CACHE = new WeakMap();   // keys array -> {sig, curves, even}
const sigOf = (keys) => keys.map((k) => `${k.frame}|${k.position}|${k.target}|${k.focal_mm}`).join(";");

/** The three curves of a key list (cached on the array, refreshed when any key changes). */
function curvesOf(keys) {
  const sig = sigOf(keys);
  const hit = CACHE.get(keys);
  if (hit?.sig === sig) return hit;
  const t = keys.map((k) => k.frame);
  const mk = (vals) => ({ t, v: vals, m: vals.length > 1 ? tangents(t, vals) : vals.map((x) => x.map(() => 0)) });
  const out = {
    sig,
    position: mk(keys.map((k) => [...k.position])),
    target: mk(keys.map((k) => [...k.target])),
    logf: mk(keys.map((k) => [Math.log(Math.max(1e-3, k.focal_mm || 35))])),
    even: null,
  };
  CACHE.set(keys, out);
  return out;
}

/** Even speed: the move's progress 0..1 at x (0..1 of the shot between its first and last key), at one speed between
 *  a smooth ease-in and ease-out of share `a` each end (the speed ramps up as a smoothstep, so it has no corner). */
export function evenProgress(x, a = EVEN_RAMP) {
  const X = Math.max(0, Math.min(1, x)), vmax = 1 / (1 - a);
  const ramp = (y) => y * y * y - 0.5 * y * y * y * y;                 // integral of smoothstep, 0.5 at y = 1
  if (X <= a) return vmax * a * ramp(X / a);
  if (X >= 1 - a) return 1 - vmax * a * ramp((1 - X) / a);
  return vmax * (a / 2 + (X - a));
}

/** Arc-length table for even speed. The measure combines the camera's own travel and its target's (ds = hypot(dpos,
 *  dtarget), metres of each): a dolly, a pan, a pan with a small dolly and a tracking move all come out at one speed
 *  in whichever dominates (timing by position alone, falling back to the target only when the camera stood perfectly
 *  still, left a pan with a 1 cm dolly 4.8x uneven). A move where both travel a lot but at different rates evens the
 *  combination, so each alone can still vary a little. Focal-only moves have no length: they play on frame time. */
function evenTable(c, divisions) {
  if (c.even?.divisions === divisions) return c.even;
  const t0 = c.position.t[0], t1 = c.position.t[c.position.t.length - 1];
  const N = Math.max(16, divisions | 0);
  const T = new Float64Array(N + 1), L = new Float64Array(N + 1);
  let pp = hermiteAt(c.position, t0), pt = hermiteAt(c.target, t0), acc = 0;
  for (let s = 0; s <= N; s++) {
    const tt = t0 + (t1 - t0) * s / N, p = hermiteAt(c.position, tt), q = hermiteAt(c.target, tt);
    if (s) acc += Math.hypot(Math.hypot(...p.map((x, k) => x - pp[k])), Math.hypot(...q.map((x, k) => x - pt[k])));
    T[s] = tt; L[s] = acc; pp = p; pt = q;
  }
  c.even = { divisions, T, L, total: acc, t0, t1 };
  return c.even;
}

/** Even speed: the curve time whose arc length is the share `s` of the path. */
function timeAtLength(E, s) {
  const want = s * E.total;
  if (E.total < 1e-9) return E.t0 + (E.t1 - E.t0) * s;
  let lo = 0, hi = E.L.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (E.L[mid] < want) lo = mid; else hi = mid; }
  const span = E.L[hi] - E.L[lo];
  const w = span > 1e-12 ? (want - E.L[lo]) / span : 0;
  return E.T[lo] + (E.T[hi] - E.T[lo]) * w;
}

/**
 * The camera at a frame on curve version 2: {position, target, focal_mm}. opts.even plays the path at even speed
 * (arc length); opts.arcLengthDivisions sets how finely the path is measured for it (default ARC_DIVISIONS).
 * A pure function of the keys and the frame: the same at frame N however it was reached (in order, shuffled, scrubbed).
 */
export function cameraCurveAt(keys, frame, { even = false, arcLengthDivisions = ARC_DIVISIONS } = {}) {
  if (!keys?.length) return null;
  if (keys.length === 1) return { position: [...keys[0].position], target: [...keys[0].target], focal_mm: keys[0].focal_mm };
  const c = curvesOf(keys);
  let t = Number(frame) || 0;
  if (even) {
    const E = evenTable(c, arcLengthDivisions);
    if (t <= E.t0) t = E.t0;
    else if (t >= E.t1) t = E.t1;
    else t = timeAtLength(E, evenProgress((t - E.t0) / (E.t1 - E.t0)));
  }
  // The focal length: in log space between keys, exactly the key's own value on a key or through a hold (no exp/log
  // rounding: 85 mm reads 85, not 85.00000000000001).
  const s = segment(c.logf.t, t);
  const onKey = s.i === s.j || s.u === 0 || sameVal(c.logf.v[s.i], c.logf.v[s.j]);
  const focal_mm = onKey ? keys[s.i].focal_mm : Math.exp(hermiteAt(c.logf, t)[0]);
  return { position: hermiteAt(c.position, t), target: hermiteAt(c.target, t), focal_mm };
}
