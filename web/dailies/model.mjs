// Dailies model: the pure half of the Dailies bin (bin.mjs) and the lined script (lined.mjs). No DOM; node-tested in
// tests/js/dailies.test.mjs.
//
//   import { takesFor, setupLabel, clipName, longLabel, coverageFor, arrangeByScript } from "./dailies/model.mjs";
//
// Vocabulary (US / LA dailies, as an Avid assistant editor names clips):
//   setup   one camera position in a scene. The first setup of scene 12 is "12", then 12A, 12B, ... (I and O are
//           skipped so they never read as 1 and 0; after Z come AA, BB, ...). A shot here = a setup.
//   take    one generation of that setup: the clay previz, a still "look" frame, a draft or a final video. Takes are
//           numbered 1..n oldest first, so a new render never renumbers the old ones. Clip name "12B-3" = scene 12,
//           setup B, take 3. The circled take is the one the director printed (in Soundstage: the chosen frame).
//   coverage the run of script elements (indices into scene.elements) a setup covers: {from, to, offscreen:[[a,b]]},
//           inclusive. Offscreen ranges are where the setup rolls but its subject is off camera: the squiggle on a
//           lined script.
//
// Host data shapes accepted by takesFor(shot, raw) (raw = whatever host.getRenders(shotId) returns):
//   1. the Soundstage render map, as rendersFor(sid) returns it: {previz, look, draft, final, final_sound?, final_audio?}
//      (URLs, latest render per kind), optionally with the pipeline's frame variations and pick merged in:
//      {...rendersFor(sid), candidates: pipeline.candidates[sid], chosen: pipeline.chosen[sid]}
//   2. an array of take records [{id?, kind, url, thumb?, seconds?, circled?, created?, seed?, model?}] (oldest first,
//      or with `created`), or {takes: [...], circled: takeId}.

export const KINDS = ["previz", "look", "draft", "final"];
export const KIND_LABEL = { previz: "Previz", look: "Look", draft: "Draft", final: "Final" };

// Setup letters: no I, no O (they read as 1 and 0 on a slate).
const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const clampI = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v))));

// ------------------------------------------------------------------------------------------------------ naming

/** 1 -> "A", 8 -> "J" (I skipped), 24 -> "Z", 25 -> "AA", 26 -> "BB". 0 or less -> "" (the bare scene number). */
export function setupLetter(k) {
  const n = Math.floor(Number(k) || 0);
  if (n <= 0) return "";
  const i = (n - 1) % LETTERS.length, rep = Math.floor((n - 1) / LETTERS.length) + 1;
  return LETTERS[i].repeat(rep);
}

/**
 * The slate name of a scene's setup by its index in shooting order: 0 -> "12" (the first setup, usually the master,
 * takes the bare scene number), 1 -> "12A", 2 -> "12B". A shot can carry its own `slate` (e.g. a reshoot "12X").
 */
export function setupLabel(scene, shotIndex, shot = null) {
  if (shot?.slate) return String(shot.slate);
  const num = String(scene?.number ?? "").trim() || "?";
  return `${num}${setupLetter(shotIndex)}`;
}

/** "12B-3": the Avid clip name for scene 12, setup index 2, take 3. */
export function clipName(scene, setupIdx, takeN, shot = null) {
  return `${setupLabel(scene, setupIdx, shot)}-${Math.max(1, Math.floor(Number(takeN) || 1))}`;
}

/** "Sc 12B Tk 3 · OTS Alex" (no take: "Sc 12B · OTS Alex"). */
export function longLabel(scene, setupIdx, shot, takeN = null) {
  const tk = takeN ? ` Tk ${takeN}` : "";
  const name = shot?.name ? ` · ${shot.name}` : "";
  return `Sc ${setupLabel(scene, setupIdx, shot)}${tk}${name}`;
}

/** The scene's shots in setup (shooting) order: shots with scene_id === scene.id, keeping the host's order. */
export function sceneShots(scene, shots) {
  if (!scene) return [];
  return (shots || []).filter((s) => s && s.scene_id === scene.id);
}

// ------------------------------------------------------------------------------------------------------ takes

const VIDEO_RE = /\.(mp4|webm|mov|m4v|mkv)(?:$|[?&#])/i;
/** True when a URL (plain or a ComfyUI /view?filename=...) points at a video file. */
export function isVideoUrl(url) {
  const u = String(url || "");
  if (!u) return false;
  try {
    const q = u.includes("?") ? new URLSearchParams(u.slice(u.indexOf("?") + 1)) : null;
    const fn = q?.get("filename");
    if (fn) return VIDEO_RE.test(fn);
  } catch { /* not a query string */ }
  return VIDEO_RE.test(u) || /^data:video\//.test(u);
}

/** Normalise a kind name: rung kinds and aliases -> previz | look | draft | final. */
export function normKind(k) {
  const s = String(k || "").toLowerCase();
  if (/^(previz|clay|rung1|1)$/.test(s)) return "previz";
  if (/^(look|frame|still|candidate|rung2|2)$/.test(s)) return "look";
  if (/^(draft|rung3|3)$/.test(s)) return "draft";
  if (/^(final|final_sound|final_audio|rung4|4)$/.test(s)) return "final";
  return KINDS.includes(s) ? s : "look";
}

/**
 * The host's renders for one shot -> takes [{id, n, kind, url, thumb, seconds?, circled, video, ...extra}], oldest
 * first and numbered 1..n. Duplicate URLs (the chosen frame is also a candidate and the latest look) collapse into
 * one take. `opts.circled` (a take id) circles a take when the data carries no circled flag of its own; the map form
 * circles the take whose url is renders.chosen.url (the pipeline's picked frame).
 */
export function takesFor(shot, renders, opts = {}) {
  let list = [];
  let circledId = opts.circled ?? null;
  if (Array.isArray(renders)) list = renders.map((t) => ({ ...t }));
  else if (isObj(renders) && Array.isArray(renders.takes)) {
    list = renders.takes.map((t) => ({ ...t }));
    if (renders.circled != null && circledId == null) circledId = renders.circled;
  } else if (isObj(renders)) {
    const r = renders;
    const urlOf = (v) => (typeof v === "string" ? v : v?.url || "");
    if (r.previz) list.push({ id: "previz", kind: "previz", url: urlOf(r.previz) });
    // Frame variations (pipeline.candidates is newest first) -> oldest first.
    const cands = Array.isArray(r.candidates) ? [...r.candidates].reverse() : [];
    cands.forEach((c, i) => { if (c?.url) list.push({ id: `look_${c.seed ?? i}`, kind: "look", url: c.url, seed: c.seed, model: c.model }); });
    if (r.look) list.push({ id: "look", kind: "look", url: urlOf(r.look) });
    const chosenUrl = urlOf(r.chosen);
    if (chosenUrl) list.push({ id: "chosen", kind: "look", url: chosenUrl, seed: r.chosen?.seed, model: r.chosen?.model });
    if (r.draft) list.push({ id: "draft", kind: "draft", url: urlOf(r.draft) });
    const fin = r.final_sound || r.final_audio || r.final;
    if (fin) list.push({ id: "final", kind: "final", url: urlOf(fin), sound: !!(r.final_sound || r.final_audio) });
    if (chosenUrl && circledId == null) circledId = { url: chosenUrl };
  }
  // Oldest first when the records are dated; stable otherwise.
  if (list.some((t) => t.created != null)) list = list.map((t, i) => [t, i]).sort((a, b) => (a[0].created ?? 0) - (b[0].created ?? 0) || a[1] - b[1]).map((x) => x[0]);
  const seen = new Map();
  const out = [];
  for (const t of list) {
    if (!t || !t.url) continue;
    if (seen.has(t.url)) { const prev = seen.get(t.url); if (t.circled) prev.circled = true; continue; }
    const kind = normKind(t.kind);
    const video = t.video ?? isVideoUrl(t.url);
    const take = { ...t, id: String(t.id ?? `${kind}_${out.length + 1}`), kind, url: t.url, video, circled: !!t.circled };
    take.thumb = t.thumb || (video ? null : t.url);
    seen.set(t.url, take);
    out.push(take);
  }
  out.forEach((t, i) => { t.n = i + 1; });
  // Ids must be unique (two "look_undefined" candidates without seeds).
  const ids = new Set();
  for (const t of out) { let id = t.id, k = 2; while (ids.has(id)) id = `${t.id}_${k++}`; t.id = id; ids.add(id); }
  if (!out.some((t) => t.circled) && circledId != null) {
    const hit = typeof circledId === "object" ? out.find((t) => t.url === circledId.url) : out.find((t) => t.id === String(circledId));
    if (hit) hit.circled = true;
  }
  // One circled take per setup: keep the last one flagged.
  const flagged = out.filter((t) => t.circled);
  for (const t of flagged.slice(0, -1)) t.circled = false;
  // A video's thumb falls back to the still it was made from (the circled, else latest, look).
  const stills = out.filter((t) => !t.video);
  for (const t of out) if (!t.thumb) t.thumb = (stills.find((s) => s.circled) || stills[stills.length - 1])?.url || null;
  return out;
}

/** The take to show / open for a setup: the circled one, else the most finished (final > draft > look > previz), latest. */
export function heroTake(takes) {
  if (!takes?.length) return null;
  const c = takes.find((t) => t.circled);
  if (c) return c;
  for (const k of ["final", "draft", "look", "previz"]) {
    const of = takes.filter((t) => t.kind === k);
    if (of.length) return of[of.length - 1];
  }
  return takes[takes.length - 1];
}

/** 5.04 -> "0:05", 75 -> "1:15", null -> "". */
export function fmtDuration(sec) {
  const s = Number(sec);
  if (!Number.isFinite(s) || s <= 0) return "";
  const r = Math.round(s);
  return `${Math.floor(r / 60)}:${String(r % 60).padStart(2, "0")}`;
}

// ------------------------------------------------------------------------------------------------------ setups

export const SETUP_GROUPS = [
  { key: "master", label: "Masters & wides", kinds: ["master", "wide"] },
  { key: "two", label: "Two-shots", kinds: ["two"] },
  { key: "ots", label: "Over-the-shoulders", kinds: ["ots"] },
  { key: "single", label: "Singles", kinds: ["single", "pov"] },
  { key: "close", label: "Close-ups", kinds: ["close"] },
  { key: "insert", label: "Inserts", kinds: ["insert"] },
  { key: "other", label: "Other", kinds: ["other"] },
];
export const SETUP_KIND_LABEL = { master: "Master", wide: "Wide", two: "Two-shot", ots: "OTS", single: "Single", close: "Close-up",
  insert: "Insert", pov: "POV", other: "Setup" };

/**
 * A shot's setup kind: master | wide | two | ots | single | close | insert | pov | other. Reads shot.setup (the
 * stage's master / wide / ots_a / single_b / two_shot / insert / pov ...) and falls back to the shot's name.
 */
export function setupKind(shot) {
  const s = String(shot?.setup || "").toLowerCase().replace(/[\s-]+/g, "_");
  const byKey = (k) => {
    if (/^(master|establishing|est)/.test(k)) return "master";
    if (/^(wide|ws|ews|ls|els|long)/.test(k)) return "wide";
    if (/^(two|2shot|2_shot|dash_two)/.test(k)) return "two";
    if (/^(ots|over)/.test(k)) return "ots";
    if (/^(single|ms|mcu|medium|mid)/.test(k)) return "single";
    if (/^(close|cu|ecu|xcu|bcu)/.test(k)) return "close";
    if (/^insert/.test(k)) return "insert";
    if (/^pov/.test(k)) return "pov";
    return null;
  };
  const k = s && byKey(s);
  if (k) return k;
  const n = String(shot?.name || "").toLowerCase();
  if (/\bmaster\b|establishing/.test(n)) return "master";
  if (/\binsert\b/.test(n)) return "insert";
  if (/\bots\b|over[- ]the[- ]shoulder/.test(n)) return "ots";
  if (/\btwo[- ]?shot\b|\b2[- ]?shot\b/.test(n)) return "two";
  if (/\bpov\b|p\.o\.v/.test(n)) return "pov";
  if (/\b(e?cu|close[- ]?up|close)\b/.test(n)) return "close";
  if (/\b(single|mcu|ms|medium)\b/.test(n)) return "single";
  if (/\b(wide|ws|long|establishing)\b/.test(n)) return "wide";
  return "other";
}

const STOP = new Set(["insert", "cu", "ecu", "close", "closeup", "up", "on", "the", "of", "a", "an", "shot", "single", "ots", "over",
  "shoulder", "pov", "wide", "master", "two", "and", "to", "in", "at", "his", "her", "their", "its", "s", "setup", "tk", "take", "mcu", "ms"]);
const words = (s) => String(s || "").toLowerCase().replace(/[’']s\b/g, "").split(/[^a-z0-9]+/).filter(Boolean);

/** Speaking characters in order of first cue (scene.characters may be alphabetical or hand-ordered). */
export function speakingOrder(scene) {
  const seen = [];
  for (const e of scene?.elements || []) if (e?.type === "character" && e.character && !seen.includes(e.character)) seen.push(e.character);
  for (const c of scene?.characters || []) if (!seen.includes(c)) seen.push(c);
  return seen;
}

/**
 * Who a setup is on: shot.character / shot.subject when it names a scene character, else single_a / ots_b -> first /
 * second speaking character, else a character word found in the shot's name ("OTS Mara", "Single · Ezra"). null when
 * the shot is not on a character.
 */
export function shotCharacter(scene, shot) {
  const chars = speakingOrder(scene);
  const match = (txt) => {
    if (!txt) return null;
    const up = String(txt).toUpperCase().trim();
    if (chars.includes(up)) return up;
    const ws = new Set(words(txt));
    // Every word of a cue name in the text ("DEPUTY COLE"), or its last/first word ("Cole", "Mara").
    return chars.find((c) => words(c).every((w) => ws.has(w))) || chars.find((c) => words(c).some((w) => w.length > 2 && ws.has(w))) || null;
  };
  const direct = match(shot?.character) || match(shot?.subject);
  if (direct) return direct;
  const ab = /_(a|b|c)$/.exec(String(shot?.setup || "").toLowerCase());
  const byName = match(shot?.name);
  if (byName) return byName;
  if (ab) return chars["abc".indexOf(ab[1])] || null;
  return null;
}

/** Dialogue blocks of a character: [[cueIndex, lastIndex]] (cue through its parentheticals and dialogue). */
export function dialogueBlocks(scene, character) {
  const els = scene?.elements || [];
  const out = [];
  for (let i = 0; i < els.length; i++) {
    const e = els[i];
    if (e?.type !== "character" || e.character !== character) continue;
    let j = i;
    while (j + 1 < els.length && (els[j + 1].type === "dialogue" || els[j + 1].type === "parenthetical" || els[j + 1].type === "lyric")
      && (!els[j + 1].character || els[j + 1].character === character)) j++;
    out.push([i, j]);
  }
  return out;
}

const mentions = (text, character) => {
  const ws = new Set(words(text));
  return words(character).some((w) => w.length > 2 && ws.has(w));
};

/** Collapse a sorted list of indices into inclusive ranges: [2,3,4,7] -> [[2,4],[7,7]]. */
function runs(idx) {
  const out = [];
  for (const i of idx) {
    const last = out[out.length - 1];
    if (last && i === last[1] + 1) last[1] = i; else out.push([i, i]);
  }
  return out;
}

/**
 * Default coverage of a setup, by kind:
 *   master / wide / two-shot / other: the whole scene.
 *   single / close-up on a character: from its first cue to the end of its last speech; the stretches in between
 *     where someone else talks (and action that does not mention the subject) are off screen (squiggle).
 *   OTS / POV on a character: the same span, all on screen (the other actor is in frame).
 *   insert: the action line that mentions the subject (shot.subject, else the words of its name); null if none.
 * A character with no lines falls back to the action lines that mention them, then to the whole scene.
 */
export function defaultCoverage(scene, shot) {
  const els = scene?.elements || [];
  const n = els.length;
  if (!n) return null;
  const all = { from: 0, to: n - 1, offscreen: [] };
  const kind = setupKind(shot);
  if (kind === "insert") {
    const ws = words(`${shot?.subject || ""} ${shot?.subject ? "" : shot?.name || ""}`).filter((w) => w.length > 2 && !STOP.has(w));
    if (!ws.length) return null;
    let best = -1, bestScore = 0;
    els.forEach((e, i) => {
      if (e?.type !== "action") return;
      const have = new Set(words(e.text));
      const score = ws.filter((w) => have.has(w) || have.has(`${w}s`) || (w.endsWith("s") && have.has(w.slice(0, -1)))).length;
      if (score > bestScore) { bestScore = score; best = i; }
    });
    return best >= 0 ? { from: best, to: best, offscreen: [] } : null;
  }
  if (!["single", "close", "ots", "pov"].includes(kind)) return all;
  const who = shotCharacter(scene, shot);
  if (!who) return all;
  const blocks = dialogueBlocks(scene, who);
  if (!blocks.length) {
    const hits = els.map((e, i) => (e?.type === "action" && mentions(e.text, who) ? i : -1)).filter((i) => i >= 0);
    return hits.length ? { from: hits[0], to: hits[hits.length - 1], offscreen: [] } : all;
  }
  const from = blocks[0][0], to = blocks[blocks.length - 1][1];
  if (kind === "ots" || kind === "pov") return { from, to, offscreen: [] };
  const on = new Set();
  for (const [a, b] of blocks) for (let i = a; i <= b; i++) on.add(i);
  const off = [];
  for (let i = from; i <= to; i++) {
    if (on.has(i)) continue;
    const e = els[i];
    if (e?.type === "action" && mentions(e.text, who)) continue;
    off.push(i);
  }
  return { from, to, offscreen: runs(off) };
}

/** Clamp and tidy a coverage against a scene of n elements: from <= to, offscreen sorted, merged, clipped. null stays null. */
export function normCoverage(cov, n) {
  if (!cov || !(n > 0) || cov.from == null || cov.to == null) return null;
  let from = clampI(cov.from, 0, n - 1), to = clampI(cov.to, 0, n - 1);
  if (to < from) [from, to] = [to, from];
  const idx = new Set();
  for (const r of cov.offscreen || []) {
    if (!Array.isArray(r)) continue;
    let a = clampI(r[0], 0, n - 1), b = clampI(r[1] ?? r[0], 0, n - 1);
    if (b < a) [a, b] = [b, a];
    for (let i = Math.max(a, from); i <= Math.min(b, to); i++) idx.add(i);
  }
  return { from, to, offscreen: runs([...idx].sort((x, y) => x - y)) };
}

/** The coverage to draw: the shot's own (shot.coverage, or `own` from the host) normalised, else the default. */
export function coverageFor(scene, shot, own = undefined) {
  const n = scene?.elements?.length || 0;
  const mine = own !== undefined ? own : shot?.coverage;
  if (mine === null && own !== undefined) return null;
  return (mine && normCoverage(mine, n)) || defaultCoverage(scene, shot);
}

/** Is element i off screen in a coverage? */
export const isOffscreen = (cov, i) => !!cov?.offscreen?.some(([a, b]) => i >= a && i <= b);

/** Flip element i between on and off camera (inside the coverage only). Returns a new coverage. */
export function toggleOffscreen(cov, i) {
  if (!cov || i < cov.from || i > cov.to) return cov;
  const idx = new Set();
  for (const [a, b] of cov.offscreen || []) for (let k = a; k <= b; k++) idx.add(k);
  if (idx.has(i)) idx.delete(i); else idx.add(i);
  return { from: cov.from, to: cov.to, offscreen: runs([...idx].sort((x, y) => x - y)) };
}

/** Move one end of a coverage to element i (the other end stays; ends swap if they cross). */
export function moveCoverageEnd(cov, end, i, n) {
  const c = cov || { from: i, to: i, offscreen: [] };
  const next = end === "from" ? { ...c, from: i } : { ...c, to: i };
  return normCoverage(next, n);
}

/**
 * Where a click on element i lands inside a take: {elementIndex, fraction, offset?}. fraction is the share of the
 * covered elements before i (0 at the top of the line), offset = fraction x take seconds when the take has a length.
 * ScriptSync-style: a rough jump, weighted by text length so a long speech gets more time than a one-word line.
 */
export function syncPoint(scene, cov, i, take = null) {
  const els = scene?.elements || [];
  if (!cov) return { elementIndex: i, fraction: 0 };
  const w = (k) => Math.max(8, String(els[k]?.text || "").length);
  let total = 0, before = 0;
  for (let k = cov.from; k <= cov.to; k++) { total += w(k); if (k < i) before += w(k); }
  const fraction = total ? Math.max(0, Math.min(1, before / total)) : 0;
  const out = { elementIndex: i, fraction };
  if (take?.seconds > 0) out.offset = Math.round(fraction * take.seconds * 100) / 100;
  return out;
}

// ------------------------------------------------------------------------------------------------------ layout

/**
 * The covered elements as shares of the take: [{i, a, b}] with a..b in 0..1 (same text-length weights as syncPoint).
 * The ScriptSync player draws them as the take bar under the picture.
 */
export function syncSegments(scene, cov) {
  if (!cov) return [];
  const els = scene?.elements || [];
  const w = (k) => Math.max(8, String(els[k]?.text || "").length);
  let total = 0;
  for (let k = cov.from; k <= cov.to; k++) total += w(k);
  const out = [];
  let acc = 0;
  for (let k = cov.from; k <= cov.to; k++) {
    const a = total ? acc / total : 0;
    acc += w(k);
    out.push({ i: k, a, b: total ? acc / total : 1, off: isOffscreen(cov, k) });
  }
  return out;
}

/** The inverse of syncPoint: which covered element a share of the take (0..1) falls on. */
export function elementAtFraction(scene, cov, fraction) {
  const segs = syncSegments(scene, cov);
  if (!segs.length) return null;
  const f = Math.max(0, Math.min(1, Number(fraction) || 0));
  for (const s of segs) if (f < s.b) return s.i;
  return segs[segs.length - 1].i;
}

/**
 * Thumbnails on a lined script sit at the top of their lines; when lines are closer together than a thumbnail is
 * wide, the thumbnails stack upward in tiers so none covers another. items: [{x, y}] (centre x, the line's top y)
 * in drawing order; returns the tier (0 = right above its line) for each item.
 */
export function stackThumbs(items, tw, tierH) {
  const placed = [];
  return (items || []).map((it) => {
    for (let t = 0; t < 64; t++) {
      const r = { l: it.x - tw / 2, r: it.x + tw / 2, top: it.y - (t + 1) * tierH, bot: it.y - t * tierH };
      if (!placed.some((p) => p.l < r.r - 0.5 && r.l < p.r - 0.5 && p.top < r.bot - 0.5 && r.top < p.bot - 0.5)) { placed.push(r); return t; }
    }
    return 0;
  });
}

/**
 * Undo for lining edits: remember each setup's coverage before an edit. push(id, before) before every change;
 * undo() -> {id, cov} to put back (cov may be null = "not lined"), or null when there is nothing to undo.
 */
export class LiningHistory {
  constructor(limit = 50) { this.limit = limit; this.stack = []; }
  push(id, before) {
    this.stack.push({ id, cov: before ? structuredClone(before) : null });
    if (this.stack.length > this.limit) this.stack.shift();
  }
  undo() { return this.stack.pop() || null; }
  get size() { return this.stack.length; }
  clear() { this.stack = []; }
}

// Frame view geometry at size 1 (the bin scales positions with its thumbnail size).
export const CARD_W = 208;
export const CARD_H = Math.round(CARD_W * 9 / 16) + 50; // 16:9 thumb + two caption lines
export const GAP = 18;
export const CELL_W = CARD_W + GAP;
export const CELL_H = CARD_H + GAP;
export const SNAP = 12;

/** Snap a coordinate to the grid (step SNAP by default); never negative. */
export const snap = (v, step = SNAP) => Math.max(0, Math.round((Number(v) || 0) / step) * step);

/** Grid cell position (column c, row r) -> {x, y} at size 1. */
export const cellPos = (c, r) => ({ x: GAP + c * CELL_W, y: GAP + r * CELL_H });

/** How many columns fit a width (at a given size). */
export const columnsFor = (width, size = 1) => Math.max(1, Math.floor((Math.max(0, (Number(width) || 0) / size) - GAP) / CELL_W));

/** Setups in script order: by where their coverage starts, longer coverage first, inserts without coverage last. */
export function scriptOrder(items) {
  return items.map((it, i) => ({ it, i })).sort((a, b) => {
    const ca = a.it.coverage, cb = b.it.coverage;
    if (!ca !== !cb) return ca ? -1 : 1;
    if (ca && cb && ca.from !== cb.from) return ca.from - cb.from;
    if (ca && cb && ca.to - ca.from !== cb.to - cb.from) return (cb.to - cb.from) - (ca.to - ca.from);
    return a.i - b.i;
  }).map((x) => x.it);
}

/**
 * Auto-arrange in script order: rows of `cols` cards. items: [{id, coverage}] (in setup order).
 * Returns {id: {x, y}} at size 1.
 */
export function arrangeByScript(items, cols = 4) {
  const pos = {};
  scriptOrder(items).forEach((it, k) => { pos[it.id] = cellPos(k % cols, Math.floor(k / cols)); });
  return pos;
}

/**
 * Auto-arrange by setup: one band of rows per setup group (masters & wides, two-shots, OTS, singles, close-ups,
 * inserts, other), script order inside a group. items: [{id, kind, coverage}]. Returns {positions, rows:[{label, y}]}.
 */
export function arrangeBySetup(items, cols = 4) {
  const positions = {}, rows = [];
  let r = 0;
  for (const g of SETUP_GROUPS) {
    const of = scriptOrder(items.filter((it) => g.kinds.includes(it.kind || "other")));
    if (!of.length) continue;
    rows.push({ key: g.key, label: g.label, y: cellPos(0, r).y });
    of.forEach((it, k) => { positions[it.id] = cellPos(k % cols, r + Math.floor(k / cols)); });
    r += Math.ceil(of.length / cols);
  }
  return { positions, rows };
}

/**
 * Tidy grid: every card to its nearest free grid cell, reading order (top-to-bottom, left-to-right) kept.
 * positions: {id: {x, y}} at size 1; ids without a position go after the others. Returns new positions.
 */
export function tidyGrid(positions, ids, cols = 4) {
  const cellOf = (p) => [Math.max(0, Math.min(cols - 1, Math.round((p.x - GAP) / CELL_W))), Math.max(0, Math.round((p.y - GAP) / CELL_H))];
  // Reading order: by the row a card is nearest to, then left to right.
  const placed = ids.filter((id) => positions?.[id]).sort((a, b) => (cellOf(positions[a])[1] - cellOf(positions[b])[1]) || (positions[a].x - positions[b].x));
  const rest = ids.filter((id) => !positions?.[id]);
  const used = new Set(), out = {};
  const key = (c, r) => `${c},${r}`;
  for (const id of placed) {
    const p = positions[id];
    const [c0, r0] = cellOf(p);
    // Nearest free cell: search rings outward, closest by distance in the ring, then right before down.
    let best = null;
    for (let d = 0; !best && d < 500; d++) {
      let bd = Infinity;
      for (let r = Math.max(0, r0 - d); r <= r0 + d; r++) {
        for (let c = Math.max(0, c0 - d); c <= Math.min(cols - 1, c0 + d); c++) {
          if (Math.max(Math.abs(r - r0), Math.abs(c - c0)) !== d || used.has(key(c, r))) continue;
          const dist = (c - c0) ** 2 + (r - r0) ** 2 * 1.01;
          if (dist < bd) { bd = dist; best = [c, r]; }
        }
      }
    }
    used.add(key(...best));
    out[id] = cellPos(...best);
  }
  let k = 0;
  for (const id of rest) {
    while (used.has(key(k % cols, Math.floor(k / cols)))) k++;
    used.add(key(k % cols, Math.floor(k / cols)));
    out[id] = cellPos(k % cols, Math.floor(k / cols));
  }
  return out;
}

/** Positions for any id missing one: appended below the lowest card, in the order given. */
export function fillPositions(positions, ids, cols = 4) {
  const out = { ...(positions || {}) };
  const missing = ids.filter((id) => !out[id]);
  if (!missing.length) return out;
  const bottom = Object.values(out).reduce((m, p) => Math.max(m, p.y + CELL_H), 0);
  const r0 = bottom ? Math.ceil((bottom - GAP) / CELL_H) : 0;
  missing.forEach((id, k) => { out[id] = cellPos(k % cols, r0 + Math.floor(k / cols)); });
  return out;
}

// ------------------------------------------------------------------------------------------------------ list view

/** One row per setup for the list view and for sorting. */
export function binRows(scene, shots, takesOf) {
  return sceneShots(scene, shots).map((shot, idx) => {
    const takes = takesOf(shot) || [];
    const hero = heroTake(takes);
    const circled = takes.find((t) => t.circled) || null;
    return { id: shot.id, shot, idx, label: setupLabel(scene, idx, shot), name: shot.name || shot.id, kind: setupKind(shot),
      takes, take_count: takes.length, circled, circled_n: circled?.n ?? null, hero, take_kind: hero?.kind || "",
      seconds: hero?.seconds ?? null };
  });
}

const KIND_RANK = { previz: 1, look: 2, draft: 3, final: 4 };
/** Natural compare for slate labels: "12" < "12A" < "12B" < "12AA". */
export function compareLabels(a, b) {
  const pa = /^(\d*)([A-Z]*)(.*)$/i.exec(String(a)) || [], pb = /^(\d*)([A-Z]*)(.*)$/i.exec(String(b)) || [];
  const na = Number(pa[1] || 0), nb = Number(pb[1] || 0);
  if (na !== nb) return na - nb;
  const la = pa[2] || "", lb = pb[2] || "";
  if (la.length !== lb.length) return la.length - lb.length;
  return la.localeCompare(lb) || String(a).localeCompare(String(b));
}

/** Sort list rows by a column: label | name | kind | takes | circled | take_kind | seconds. dir 1 or -1. Stable. */
export function sortRows(rows, key = "label", dir = 1) {
  const val = {
    label: null, name: (r) => r.name.toLowerCase(), kind: (r) => r.kind, takes: (r) => r.take_count,
    circled: (r) => r.circled_n ?? -1, take_kind: (r) => KIND_RANK[r.take_kind] || 0, seconds: (r) => r.seconds ?? -1,
  }[key];
  return rows.map((r, i) => ({ r, i })).sort((a, b) => {
    let c;
    if (key === "label" || !val) c = compareLabels(a.r.label, b.r.label);
    else { const x = val(a.r), y = val(b.r); c = x < y ? -1 : x > y ? 1 : 0; }
    return c * (dir < 0 ? -1 : 1) || a.i - b.i;
  }).map((x) => x.r);
}

/** Rows whose label, name, setup kind or take kinds contain every word of the query; "circled" keeps circled setups. */
export function filterRows(rows, query) {
  const ws = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!ws.length) return rows;
  return rows.filter((r) => {
    const hay = [r.label, r.name, r.kind, SETUP_KIND_LABEL[r.kind], ...r.takes.map((t) => t.kind), r.circled ? "circled" : ""].join(" ").toLowerCase();
    return ws.every((w) => hay.includes(w));
  });
}

// ------------------------------------------------------------------------------------------------------ colours

// Line colours for a lined script (ink on cream paper) and the matching dot on a bin card.
export const SETUP_COLORS = ["#d43a3a", "#2463c9", "#17915a", "#d97706", "#7c3aed", "#0e8f9e", "#c0267a", "#5e7d0b", "#8a5a2b",
  "#3f4fb5", "#b8860b", "#475569"];
export const setupColor = (idx) => SETUP_COLORS[((idx % SETUP_COLORS.length) + SETUP_COLORS.length) % SETUP_COLORS.length];

// ------------------------------------------------------------------------------------------------------ approvals
//
// Every take (a frame, a draft or a final) can carry a review status with a short note, kept in the workflow
// (node.properties.ss_approvals): {shotId: {takeKey: {s, note?, t?, kind?}}}. takeKey is the render's file (stable across
// reloads and across views: the same frame in ④ Frame, the bin and the Ladder has one status). Unreviewed = no entry.

export const STATUS_ORDER = ["", "approved", "changes", "rejected"];
export const STATUS_META = {
  "": { label: "Unreviewed", sym: "", word: "unreviewed" },
  approved: { label: "Approved", sym: "✓", word: "approved" },
  changes: { label: "Needs changes", sym: "↺", word: "needs changes" },
  rejected: { label: "Rejected", sym: "✕", word: "rejected" },
};
export const STATUS_FILTERS = [["all", "All"], ["approved", "Approved"], ["changes", "Needs changes"], ["", "Unreviewed"]];

/** "approved" | "changes" | "rejected" | "" (unreviewed). Accepts aliases (ok, yes, no, redo, needs changes...). */
export function normStatus(s) {
  const v = String(s ?? "").toLowerCase().trim();
  if (/^(approved?|ok|yes|good|✓|circle[d]?)$/.test(v)) return "approved";
  if (/^(changes|needs[ _-]?changes|change|redo|fix|↺)$/.test(v)) return "changes";
  if (/^(rejected?|no|ng|nogood|no[ _-]good|✕|x)$/.test(v)) return "rejected";
  return "";
}

/** Next status on a quick click: unreviewed → approved → needs changes → rejected → unreviewed. */
export const nextStatus = (s) => STATUS_ORDER[(STATUS_ORDER.indexOf(normStatus(s)) + 1) % STATUS_ORDER.length];

const hashStr = (s) => { let x = 2166136261; for (let i = 0; i < s.length; i++) x = Math.imul(x ^ s.charCodeAt(i), 16777619); return (x >>> 0).toString(36); };

/**
 * The stable key of a take: a ComfyUI /view?filename=..&subfolder=..&type=.. URL -> "type:subfolder/filename" (cache
 * busters and the host part dropped); a data: URL -> a short hash; anything else -> the URL without its query string.
 * Takes a take record ({url}) or a URL.
 */
export function takeKey(takeOrUrl) {
  const u = String(typeof takeOrUrl === "string" ? takeOrUrl : takeOrUrl?.url || "");
  if (!u) return "";
  if (u.startsWith("data:")) return `data:${hashStr(u)}`;
  const qi = u.indexOf("?");
  if (qi >= 0) {
    try {
      const q = new URLSearchParams(u.slice(qi + 1).split("#")[0]);
      const fn = q.get("filename");
      if (fn) return `${q.get("type") || "output"}:${q.get("subfolder") ? `${q.get("subfolder")}/` : ""}${fn}`;
    } catch { /* not a query */ }
    return u.slice(0, qi);
  }
  return u.split("#")[0];
}

/** One take's review: {status, note, t}. Unreviewed: {status: "", note: ""}. */
export function getTakeStatus(store, shotId, takeOrUrl) {
  const rec = store?.[shotId]?.[takeKey(takeOrUrl)];
  return { status: normStatus(rec?.s), note: String(rec?.note || ""), t: rec?.t ?? null };
}

/**
 * A new store with one take's status set (status "" with no note removes the entry). The note is kept when only the
 * status changes (pass note to replace it). Does not touch the input.
 */
export function withTakeStatus(store, shotId, takeOrUrl, status, note = undefined, extra = {}) {
  const key = takeKey(takeOrUrl);
  const out = { ...(store || {}) };
  if (!key || !shotId) return out;
  const shot = { ...(out[shotId] || {}) };
  const prev = shot[key] || {};
  const s = normStatus(status);
  const n = String(note !== undefined ? note : prev.note || "").slice(0, 500);
  if (!s && !n.trim()) delete shot[key];
  else shot[key] = { ...prev, ...extra, s, ...(n.trim() ? { note: n } : { note: undefined }), t: extra.t ?? Date.now() };
  if (shot[key] && shot[key].note === undefined) delete shot[key].note;
  if (Object.keys(shot).length) out[shotId] = shot; else delete out[shotId];
  return out;
}

/**
 * The take a shot is judged on: the latest final, else the latest draft, else the circled (chosen) frame, else the
 * latest frame. Clay previz is never reviewed. null when the shot has no frame or video yet.
 */
export function currentTake(takes) {
  const of = (k) => (takes || []).filter((t) => t.kind === k);
  const last = (a) => a[a.length - 1] || null;
  return last(of("final")) || last(of("draft")) || of("look").find((t) => t.circled) || last(of("look")) || null;
}

/**
 * A shot's status = its current take's status (a new take after a "needs changes" is unreviewed until looked at).
 * statusOfTake(take) -> {status, note}. Returns {status, note, take} (take null: nothing to review yet).
 */
export function shotStatus(takes, statusOfTake) {
  const take = currentTake(takes);
  if (!take) return { status: "", note: "", take: null };
  const st = statusOfTake(take) || {};
  return { status: normStatus(st.status), note: String(st.note || ""), take };
}

/** Counts over rows [{status}]: {total, approved, changes, rejected, unreviewed}. */
export function statusCounts(rows) {
  const c = { total: 0, approved: 0, changes: 0, rejected: 0, unreviewed: 0 };
  for (const r of rows || []) { c.total++; const s = normStatus(r?.status); c[s || "unreviewed"]++; }
  return c;
}

/** "Sc 3 · 4/6 approved" (+ " · 1 to fix" when some need changes). */
export function progressLabel(scene, counts) {
  const fix = counts.changes ? ` · ${counts.changes} to fix` : "";
  return `Sc ${scene?.number ?? "?"} · ${counts.approved}/${counts.total} approved${fix}`;
}

/** Rows kept by a status filter: "all" | "approved" | "changes" | "rejected" | "" (unreviewed). */
export function filterByStatus(rows, filter) {
  if (filter == null || filter === "all") return rows;
  const f = normStatus(filter);
  return (rows || []).filter((r) => normStatus(r?.status) === f);
}

// ------------------------------------------------------------------------------------------------------ scene bins
//
// Bins named the way an assistant editor preps an Avid project: one bin per scene, in script order, the scene number
// zero-padded so the bins sort, then a one-line description of what the scene is about: "SC 03 – Mara confronts the
// sheriff". The description is written from the script breakdown and can be edited.

/** "3" -> "03", "12A" -> "12A", "2a" -> "02A"; width 3 for scripts past scene 99. Non-numbered stays as is. */
export function padSceneNumber(number, width = 2) {
  const m = /^(\d+)(.*)$/.exec(String(number ?? "").trim());
  if (!m) return String(number ?? "").trim().toUpperCase() || "?";
  return m[1].padStart(width, "0") + m[2].toUpperCase();
}

/** The pad width for a script: 3 when any scene number reaches 100. */
export const sceneNumberWidth = (scenes) => ((scenes || []).some((s) => parseInt(String(s?.number ?? ""), 10) >= 100) ? 3 : 2);

const SMALL = new Set(["a", "an", "the", "of", "and", "or", "in", "on", "at", "to", "for", "by", "with", "from"]);
const titleCase = (s) => String(s || "").toLowerCase().split(/(\s+)/).map((w, i) => (i && SMALL.has(w) ? w : w.replace(/^[a-z]/, (c) => c.toUpperCase()))).join("");

/** Screenplay CAPS -> sentence case: cast names Title Case, other shouted words lower case. */
function unshout(text, cast) {
  const names = new Set((cast || []).flatMap((c) => words(c)));
  return String(text || "").replace(/\b[A-Z][A-Z'’.-]+\b/g, (w) => (names.has(w.toLowerCase().replace(/[’']s$/, "")) ? w[0] + w.slice(1).toLowerCase() : w.toLowerCase()));
}

/** Shorten to ~max chars: the first sentence, then the first clause, then a word boundary with "…". */
function shortLine(text, max = 60) {
  let s = String(text || "").replace(/\s+/g, " ").trim();
  s = (s.match(/^.*?[.!?](?=\s|$)/)?.[0] || s).replace(/[.!?]+$/, "").trim();
  if (s.length > max) {
    const comma = s.indexOf(",", 20);
    if (comma > 0 && comma <= max) s = s.slice(0, comma);
  }
  if (s.length > max) s = `${s.slice(0, max).replace(/\s+\S*$/, "")}…`;
  return s.replace(/^(a|an|the)\s+/i, "").replace(/^[a-z]/, (c) => c.toUpperCase());
}

/**
 * A one-line description of what a scene is about, from the script breakdown: the synopsis's first sentence when
 * there is one, else the first action line that puts the cast (or the scene's vehicles, props or stunts) in motion,
 * else the location. "Mara faces down the old sheriff for her father's car key".
 */
export function autoSceneDescription(scene) {
  if (!scene) return "";
  const cast = scene.breakdown?.cast?.length ? scene.breakdown.cast : (scene.characters || []);
  if (String(scene.synopsis || "").trim()) return shortLine(unshout(scene.synopsis, cast));
  const b = scene.breakdown || {};
  const things = [...(b.vehicles || []), ...(b.stunts || []), ...(b.props || []), ...(b.animals || [])].flatMap((x) => words(x)).filter((w) => w.length > 2 && !STOP.has(w));
  const castWords = cast.flatMap((c) => words(c)).filter((w) => w.length > 2);
  let best = null, bestScore = 0;
  const sentences = (scene.elements || []).filter((e) => e?.type === "action").flatMap((e) => String(e.text || "").match(/[^.!?]+[.!?]*/g) || []);
  for (const line of sentences) {
    const ws = new Set(words(line));
    const score = (castWords.some((w) => ws.has(w)) ? 3 : 0) + (things.some((w) => ws.has(w)) ? 2 : 0);
    if (score > bestScore) { best = line; bestScore = score; }
    if (score >= 3) break;
  }
  if (best) return shortLine(unshout(best, cast));
  const where = scene.location || String(scene.heading || "").replace(/^(INT|EXT|INT\.?\/EXT|I\/E)\.?\s*/i, "").replace(/\s+-\s+(DAY|NIGHT|DUSK|DAWN|SUNSET|MORNING|EVENING|CONTINUOUS|LATER).*$/i, "");
  return titleCase(where).trim();
}

/** The bin name: "SC 03 – Mara confronts the sheriff" (no description: "SC 03"). */
export function sceneBinName(scene, description = null, width = 2) {
  const d = String(description ?? autoSceneDescription(scene) ?? "").trim();
  return `SC ${padSceneNumber(scene?.number ?? (scene?.index != null ? scene.index + 1 : "?"), width)}${d ? ` – ${d}` : ""}`;
}
