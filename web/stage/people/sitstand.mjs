// Sit-down and stand-up transitions (timed sits): a person walks to a chair, turns, sits; later stands up and steps
// away. Pure timing and curves (no three.js, no clock), so node tests check them and every frame is the same in any
// scrub order. The stage keeps the spans (stage._sitSpans / _sitSpanAt), the body is posed by people/avatars.mjs
// (sitStandBody) and the clay logic rig by stage.setFrame.
//
// A span on a person: {on: seat id, at: frame | null, to: frame | null}.
//   at    the frame they start to sit: they are standing at the stand spot in front of the seat (the keys hold them
//         there), and turn to face the seat's way over TURN_S, then sit down over DOWN_S. null = seated from the
//         shot's first frame.
//   to    the frame they start to stand up (over UP_S); then they are on their own keys again (a walk away). null =
//         seated to the shot's end.
// Real Rocketbox has no sit-down or stand-up clip in the MIT animation set (0943055 has only seated idles), so the
// transitions are procedural: the standing idle and the seated idle (f_ / m_sit_chair_idle) blended joint by joint,
// the hips on a path from over the feet to the seat, the trunk leaning forward over the knees, the legs solved onto
// feet that stay planted where they stood.

export const TURN_S = 0.9;    // turning round to face the seat's way (180 degrees at most ~300 deg/s, the heading cap)
export const DOWN_S = 1.1;    // standing to seated
export const UP_S = 1.2;      // seated to standing (leaning forward first, then up)
/** The stand spot: this far (m, at 1.8 m tall) ahead of the seat point along the seat's facing. The heels are then
 *  ~13 cm in front of a library chair's front edge (0.225 m), the calves clear of it. */
export const STAND_OFF = 0.36;
/** How far (m) the hips (thigh roots' midpoint) sit above the seat top, and back from the seat point (at 1.8 m): the
 *  same as people/avatars.mjs sitBody. */
export const HIP_UP = 0.10, HIP_BACK = 0.06;
/** The trunk's forward lean at its most (radians): about 30 degrees sitting down, 34 standing up. */
export const LEAN_DOWN = 0.52, LEAN_UP = 0.6;

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const smooth = (x) => { const t = clamp01(x); return t * t * (3 - 2 * t); };
const smoother = (x) => { const t = clamp01(x); return t * t * t * (t * (6 * t - 15) + 10); };

/** Frame counts at this fps: {turn, down, up} (at least 1 each). */
export function frames(fps = 24) {
  return { turn: Math.max(1, Math.round(TURN_S * fps)), down: Math.max(1, Math.round(DOWN_S * fps)), up: Math.max(1, Math.round(UP_S * fps)) };
}

const num = (v) => (v == null ? null : Number.isFinite(+v) ? +v : NaN);

/** The span's frames: {start (turn starts), down (sit-down starts), seated (fully seated), up (stand-up starts), end
 *  (standing; the first frame back on the keys)}. Open ends are -Infinity / Infinity. */
export function window(span, fps = 24) {
  const n = frames(fps), at = num(span?.at), to = num(span?.to);
  const start = at == null ? -Infinity : at;
  const up = to == null ? Infinity : to;
  return { start, down: start + n.turn, seated: start + n.turn + n.down, up, end: up + n.up };
}

/** Is this span well formed? null, or why not (for the API's refusals). */
export function spanError(span, fps = 24) {
  if (!span || typeof span !== "object") return "not a span";
  if (typeof span.on !== "string" || !span.on) return "no seat";
  const at = num(span.at), to = num(span.to);
  if (Number.isNaN(at) || Number.isNaN(to)) return "frames must be numbers";
  if (at != null && at < 0) return "the sit can't start before frame 0";
  const w = window(span, fps);
  if (to != null && at != null && w.up < w.seated) return `stands up (frame ${to}) before they are seated (frame ${w.seated})`;
  return null;
}

/**
 * Where a person is in this span at frame f: null (not in it), or {phase: "turn" | "down" | "seated" | "up", t (0..1
 * through the phase; 0 when seated)}.
 */
export function phaseAt(span, f, fps = 24) {
  const w = window(span, fps);
  if (!(f >= w.start) || !(f < w.end)) return null;
  if (f < w.down) return { phase: "turn", t: (f - w.start) / (w.down - w.start) };
  if (f < w.seated) return { phase: "down", t: (f - w.down) / (w.seated - w.down) };
  if (f < w.up) return { phase: "seated", t: 0 };
  return { phase: "up", t: (f - w.up) / (w.end - w.up) };
}

/** The span of a list that frame f is in (the first one), with its phase: {span, phase, t, w} or null. */
export function spanAt(spans, f, fps = 24) {
  for (const s of spans || []) {
    const p = phaseAt(s, f, fps);
    if (p) return { span: s, ...p, w: window(s, fps) };
  }
  return null;
}

/**
 * The transition curves at phase / t: {back (0 standing over the feet .. 1 the hips over the seat, horizontally),
 * down (0 standing hip height .. 1 on the seat), lean (radians forward, over the standing pose and the seated one),
 * w (0 the standing idle .. 1 the seated idle, joint by joint)}.
 * Sitting down: the knees go first and the trunk leans over them while the hips go back, then the hips come down onto
 * the seat (a soft landing: the descent's speed is zero when they touch), the trunk back up as they land.
 * Standing up: the trunk leans forward over the feet first, the hips slide a little forward on the seat and leave it
 * once the weight is over the feet (~22 % in), then rise; the trunk straightens as the legs extend.
 */
export function curves(phase, t) {
  if (phase === "seated") return { back: 1, down: 1, lean: 0, w: 1 };
  if (phase === "down") {
    return {
      back: smooth(t / 0.8),
      down: smoother((t - 0.08) / 0.92),
      lean: LEAN_DOWN * Math.sin(Math.PI * clamp01(t / 0.95)) ** 1.3,
      w: smooth((t - 0.1) / 0.8),
    };
  }
  if (phase === "up") {
    return {
      back: 1 - smooth((t - 0.05) / 0.7),
      down: 1 - smoother((t - 0.22) / 0.78),
      lean: LEAN_UP * Math.sin(Math.PI * clamp01(t / 0.9)) ** 1.1,
      w: 1 - smooth((t - 0.15) / 0.8),
    };
  }
  return { back: 0, down: 0, lean: 0, w: 0 };   // standing (turning round, or none)
}

/** The stand spot [x, z] for a seat point [x, y, z] facing yaw (radians, +Z at 0), for a person heightM tall. */
export function standSpot(seat, yaw, heightM = 1.8) {
  const d = STAND_OFF * heightM / 1.8;
  return [seat[0] + Math.sin(yaw) * d, seat[2] + Math.cos(yaw) * d];
}

/** The seated hips' target [x, y, z] (the thigh roots' midpoint) for a seat point facing yaw. */
export function seatedHips(seat, yaw, heightM = 1.8) {
  const s = heightM / 1.8;
  return [seat[0] - Math.sin(yaw) * HIP_BACK * s, seat[1] + HIP_UP * s, seat[2] - Math.cos(yaw) * HIP_BACK * s];
}

const wrap = (x) => Math.atan2(Math.sin(x), Math.cos(x));
/** The heading while turning round: from `from` (the heading they arrived with) to `to` (the seat's way) over the
 *  turn, eased at both ends, the short way round. */
export function turnHeading(from, to, t) {
  return from + wrap(to - from) * smooth(t);
}

/** A whole-shot key for caches: the spans as a string. */
export const spansSig = (spans) => (spans?.length ? JSON.stringify(spans.map((s) => [s.on, s.at ?? null, s.to ?? null])) : "");
