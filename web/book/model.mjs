// The Director's Book (Milestone 23): the data model, pure (no DOM), shared by the Book view, the print binder, the
// Markdown export, the Director's context and the tests.
//
// The template is the directors' binder (share/Research_Directors_Binders/REPORT.txt): a one-line Spine for the film
// (Kazan); per scene a Coppola Godfather Notebook cover sheet (Synopsis / The Times / Imagery & Tone / The Core /
// Pitfalls) plus subtext, lighting, performance and continuity; the script page with layered margin notes; a numbered
// shot strip (12A, 12B; dropped shots struck through, never deleted); a floor plan; a Hitchcock-style sound lane; a
// lined-script strip (story day, time of day, planned / shot / cut) and a revision history.
//
// Every page field has a source: "director" (typed by hand: never overwritten), "llm" (drafted by the local model,
// checked against the script on the server) or "rules" (read off the script and the stage, recomputed each time).
//
//   const book = emptyBook(script);
//   const page = pageFor(book, script, scene, stageJSON, look);      // {fields: {key: {value, source}}, shots, ...}
//   setField(book, scene.id, "core", "She takes back what's hers.");  // the director's words win from now on
//   mergeDraft(book, scene.id, sections, { by: "llm" });             // the model fills what the director hasn't
//   getBookContext(book, script, scene.id)                            // what the Director / Pitch read every command

export const BOOK_VERSION = 1;

/** The cover-sheet and prose fields of a scene page, in reading order. kind: text | list | perf | sound. */
export const FIELDS = [
  { key: "synopsis", label: "Synopsis", kind: "text", hint: "What literally happens." },
  { key: "times", label: "The Times", kind: "text", hint: "The time, place and world the scene must show." },
  { key: "imagery", label: "Imagery & Tone", kind: "text", hint: "Visual and emotional texture. These words go into the prompts." },
  { key: "references", label: "References", kind: "list", hint: "A film or painting, and what to take from it." },
  { key: "core", label: "The Core", kind: "text", hint: "The scene's single feeling or goal, serving the spine." },
  { key: "subtext", label: "Between the lines", kind: "text", hint: "What is unsaid: the subtext." },
  { key: "pitfalls", label: "Pitfalls", kind: "list", hint: "What to avoid. Said positively in the prompts (CFG 1 has no negatives)." },
  { key: "lighting", label: "Lighting design", kind: "text", hint: "Key and fill, motivation, time of day, colour." },
  { key: "performance", label: "Performance", kind: "perf", hint: "What we need from each character." },
  { key: "sound", label: "Sound lane", kind: "sound", hint: "What we hear, and why. Silence is a choice too." },
  { key: "continuity", label: "Continuity & props", kind: "text", hint: "What must match from scene to scene." },
];
export const FIELD_KEYS = FIELDS.map((f) => f.key);
export const DRAFTABLE = ["synopsis", "times", "imagery", "references", "core", "subtext", "pitfalls", "constraints", "lighting", "performance", "sound"];

/** Note categories = the margin layers of the script page (De Niro's red marks: one colour per department). */
export const CATEGORIES = [
  { key: "subtext", label: "Subtext", color: "#c9a2ff" },
  { key: "performance", label: "Performance", color: "#ff9db0" },
  { key: "blocking", label: "Blocking", color: "#7ec8ff" },
  { key: "camera", label: "Camera", color: "#f2ff59" },
  { key: "lighting", label: "Lighting", color: "#ffc46b" },
  { key: "sound", label: "Sound", color: "#7ee2a8" },
  { key: "continuity", label: "Continuity", color: "#b9b4ad" },
];
export const CAT = Object.fromEntries(CATEGORIES.map((c) => [c.key, c]));

/** Script revision colours, in the industry's order (white draft, then blue, pink, yellow...). */
export const REV_COLOURS = ["White", "Blue", "Pink", "Yellow", "Green", "Goldenrod", "Buff", "Salmon", "Cherry", "Tan"];

/** Where the template comes from: the Book's About page. */
export const SOURCES = [
  ["Elia Kazan, Kazan on Directing (Knopf, 2009)", "the Spine: one line for the whole film"],
  ["Francis Ford Coppola, The Godfather Notebook (Regan Arts, 2016)", "the per-scene cover sheet: Synopsis, The Times, Imagery & Tone, The Core, Pitfalls"],
  ["Stanislavski's production score for The Seagull (1898)", "the script page with notes in the margin"],
  ["Robert De Niro papers, Harry Ransom Center (UT Austin)", "notes in layers, one colour per role"],
  ["Hitchcock's storyboards (T. L. Moral, Alfred Hitchcock Storyboards, 2024); Stage Fright boards", "the numbered shot strip, with dropped shots struck through"],
  ["Stephen Rebello, Alfred Hitchcock and the Making of Psycho (1990)", "the sound lane: what we hear and why, silence included"],
  ["Sergei Eisenstein, The Film Sense (1942)", "time-aligned tracks: picture and sound together"],
  ["Script-supervisor lining (Peggy Robertson papers, Margaret Herrick Library)", "the lined-script strip: planned, shot, cut"],
  ["Steven Maras, Screenwriting (2009); Bill Krohn, Hitchcock at Work (2000)", "a living document with a revision history, not a frozen blueprint"],
  ["Storyflow, What goes in a director's book", "organise by scene, not by department"],
];

const clone = (o) => JSON.parse(JSON.stringify(o ?? null));
const now = () => Date.now();
const words = (s) => String(s || "").toLowerCase().match(/[a-z0-9]+/g) || [];
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
export const niceName = (n) => String(n || "").toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

// --------------------------------------------------------------------------------------------- pitfalls -> prompts

/** Pitfall -> the positive words for the prompt (mirror of soundstage/book/prompting.py; CFG 1 ignores negatives). */
const POSITIVE = [
  [/melodram|over-?the-?top|hysteric/i, "restrained, understated performance"],
  [/overact|mugging|hamm/i, "still, minimal performance"],
  [/sentimental|schmaltz|saccharine|weepy/i, "dry, unsentimental tone"],
  [/clich|generic|stock/i, "specific, observed details"],
  [/cheesy|campy|camp\b|parody|spoof|pastiche/i, "sincere, grounded tone, played straight"],
  [/slapstick|goofy|silly|comed/i, "played straight, serious tone"],
  [/shaky|handheld|wobbl|jitter/i, "steady, locked-off camera"],
  [/music video|flashy|showy|gimmick/i, "unhurried, classical framing"],
  [/fast cut|choppy|frantic edit/i, "long, patient takes"],
  [/glossy|commercial|advert|plastic|polished/i, "naturalistic, lived-in textures"],
  [/saturat|teal|orange and teal|neon overload|garish/i, "natural, muted colour"],
  [/too dark|murky|muddy|crushed black/i, "readable exposure, detail in the shadows"],
  [/blown|overexpos|washed out/i, "protected highlights, rich colour"],
  [/flare|lens flare/i, "clean, crisp lens"],
  [/gore|gory|blood/i, "violence kept off screen, implied"],
  [/horror|scary|spooky/i, "quiet, real-world dread"],
  [/glamou?r|beauty shot|model/i, "unglamorous, natural faces"],
  [/smil|grin/i, "serious, unsmiling expression"],
  [/rush|hurried|rushed/i, "slow, deliberate pacing"],
  [/static|stiff|wooden/i, "natural, relaxed movement"],
  [/busy|clutter|crowd/i, "clean, simple frame"],
  [/slow[- ]?mo/i, "real-time motion"],
  [/cgi|cg look|video ?game|cartoon/i, "photographic, physically real"],
];
const NEG = /\b(no|not|never|avoid|don'?t|without)\b/i;
export function positiveConstraints(pitfalls) {
  const out = [];
  for (const p of pitfalls || []) {
    const t = String(p || "").trim();
    if (!t) continue;
    const hit = POSITIVE.find(([re]) => re.test(t));
    if (hit) out.push(hit[1]);
    else if (!NEG.test(t)) out.push(t);
  }
  return [...new Set(out)];
}

// --------------------------------------------------------------------------------------------- the book

export function emptyBook(script = null) {
  return { v: BOOK_VERSION, title: script?.title || "", author: script?.author || "", spine: "", statement: "",
    rules: [], style: [], constraints: [], scenes: {}, notes: [], revisions: [], journal: "", created: now(), updated: now(),
    edited: {} };
}

/** A book read from storage, upgraded and with every collection present. */
export function normalizeBook(b, script = null) {
  const e = emptyBook(script);
  if (!b || typeof b !== "object") return e;
  const out = { ...e, ...b };
  for (const k of ["rules", "style", "constraints", "notes", "revisions"]) if (!Array.isArray(out[k])) out[k] = [];
  if (!out.scenes || typeof out.scenes !== "object") out.scenes = {};
  if (!out.edited || typeof out.edited !== "object") out.edited = {};
  if (!out.title && script?.title) out.title = script.title;
  return out;
}

export function scenePage(book, id) {
  const p = (book.scenes[id] ||= {});
  p.edited ||= {}; p.src ||= {}; p.dropped ||= {}; p.shot_notes ||= {}; p.shots_seen ||= {};
  return p;
}

/** The director types a field: it's theirs now (the model never overwrites it). */
export function setField(book, sceneId, key, value) {
  const p = scenePage(book, sceneId);
  const empty = value == null || value === "" || (Array.isArray(value) && !value.length) || (typeof value === "object" && !Array.isArray(value) && !Object.keys(value).length);
  if (empty) { delete p[key]; delete p.edited[key]; delete p.src[key]; }
  else { p[key] = clone(value); p.edited[key] = true; p.src[key] = "director"; }
  // Pitfalls you write become the prompt's positive constraints (unless you wrote those yourself).
  if (key === "pitfalls" && !p.edited.constraints) { const c = positiveConstraints(value || []); if (c.length) { p.constraints = c; p.src.constraints = "director"; } else { delete p.constraints; delete p.src.constraints; } }
  book.updated = now();
  return book;
}

/** A book-wide field (spine, statement, rules, style, journal, title). */
export function setBookField(book, key, value) {
  book[key] = clone(value);
  book.edited[key] = true;
  book.updated = now();
  return book;
}

/** The model's draft for a scene: fills only what the director hasn't written. Returns the keys it filled. */
export function mergeDraft(book, sceneId, sections = {}, { by = "llm", grounding = null } = {}) {
  const p = scenePage(book, sceneId);
  const filled = [];
  for (const k of DRAFTABLE) {
    const v = sections[k];
    if (v == null || p.edited[k]) continue;
    if (k === "performance" && typeof v === "object") {
      const perf = { ...(p.performance || {}) };
      for (const [who, t] of Object.entries(v)) if (!(p.edited_perf || {})[who]) perf[who] = t;
      p.performance = perf;
    } else p[k] = clone(v);
    p.src[k] = by;
    filled.push(k);
  }
  p.drafted = { by, at: now(), grounding: grounding || null, fields: filled };
  book.updated = now();
  return filled;
}

export function mergeSpine(book, { spine, statement } = {}, by = "llm") {
  if (spine && !book.edited.spine) book.spine = spine;
  if (statement && !book.edited.statement) book.statement = statement;
  book.spine_by = by;
  book.updated = now();
}

// --------------------------------------------------------------------------------------------- shots, camera plan

/** A, B, ... Z, AA, AB ... */
export function shotLetter(i) {
  let s = "", n = i;
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
}
/** Scene 12, shot 0 -> 12A; scene 2A, shot 1 -> 2A-B (the letter would run into the scene's own). */
export function shotNumber(sceneNum, i) {
  const n = String(sceneNum ?? "");
  return /[a-z]$/i.test(n) ? `${n}-${shotLetter(i)}` : `${n}${shotLetter(i)}`;
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len2 = (v) => Math.hypot(v[0], v[2]);

function keyAt(keys, f) {
  const ks = [...(keys || [])].sort((a, b) => (a.frame || 0) - (b.frame || 0));
  if (!ks.length) return null;
  if (f <= (ks[0].frame || 0)) return ks[0];
  for (let i = 1; i < ks.length; i++) {
    const a = ks[i - 1], b = ks[i];
    if (f <= b.frame) {
      const t = (f - a.frame) / Math.max(1, b.frame - a.frame);
      const L = (p, q) => (p && q ? p.map((v, j) => v + (q[j] - v) * t) : p || q);
      return { frame: f, position: L(a.position, b.position), target: L(a.target, b.target), focal_mm: a.focal_mm + ((b.focal_mm ?? a.focal_mm) - a.focal_mm) * t };
    }
  }
  return ks[ks.length - 1];
}

function actorKeys(a, last) {
  if (a.keys?.length) return [...a.keys].sort((p, q) => p.frame - q.frame);
  const k = [{ frame: 0, position: a.position || [0, 0, 0] }];
  if (a.position_end) k.push({ frame: last, position: a.position_end });
  return k;
}

/** Where an actor is at frame f, and which way it is heading (radians, atan2(dx, dz)). */
export function actorAt(a, f, last = 96) {
  const ks = actorKeys(a, last);
  const k = keyAt(ks, f) || { position: [0, 0, 0] };
  const k2 = keyAt(ks, Math.min(last, f + 4)) || k, k1 = keyAt(ks, Math.max(0, f - 4)) || k;
  const d = sub(k2.position, k1.position);
  const heading = len2(d) > 1e-3 ? Math.atan2(d[0], d[2]) : ((a.rotation_deg?.[1] ?? a.rotation_deg ?? 0) * Math.PI) / 180;
  return { position: k.position, heading };
}

const lastFrameOf = (stage) => Math.max(1, (stage?.shot?.frames || 97) - 1);

/** A shot's camera keys in world space (a ride-along camera's keys live in its vehicle's space). */
export function worldCameraKeys(stage, shot) {
  const keys = shot?.camera_keys || [];
  const hostId = shot?.camera_follow;
  const host = hostId && (stage?.actors || []).find((a) => a.id === hostId);
  if (!host) return keys;
  const last = lastFrameOf(stage);
  const T = (p, f) => {
    const { position: hp, heading: h } = actorAt(host, f, last);
    const c = Math.cos(h), s = Math.sin(h);
    return [hp[0] + p[0] * c + p[2] * s, hp[1] + p[1], hp[2] - p[0] * s + p[2] * c];
  };
  return keys.map((k) => ({ ...k, position: T(k.position, k.frame || 0), target: k.target ? T(k.target, k.frame || 0) : k.target }));
}

/** The camera move in words, from the first and last key: static, push in / pull out, track, crane, pan, zoom. */
export function moveOf(keys, { follow = null } = {}) {
  const ks = [...(keys || [])].sort((a, b) => (a.frame || 0) - (b.frame || 0));
  if (ks.length < 2) return follow ? `rides with the ${follow}` : "static";
  const a = ks[0], b = ks[ks.length - 1];
  const d = sub(b.position, a.position);
  const look = sub(a.target || [0, 0, 0], a.position);
  const ll = Math.hypot(...look) || 1;
  const fwd = [look[0] / ll, 0, look[2] / ll];
  const fl = Math.hypot(fwd[0], fwd[2]) || 1;
  const along = (d[0] * fwd[0] + d[2] * fwd[2]) / fl;
  const side = (d[0] * fwd[2] - d[2] * fwd[0]) / fl;
  const up = d[1];
  const parts = [];
  const m = (v) => `${Math.abs(v).toFixed(1)} m`;
  if (Math.abs(along) > 0.4 && Math.abs(along) >= Math.abs(side)) parts.push(along > 0 ? `push in ${m(along)}` : `pull out ${m(along)}`);
  if (Math.abs(side) > 0.4 && Math.abs(side) > Math.abs(along) * 0.5) parts.push(`track ${side > 0 ? "left" : "right"} ${m(side)}`);
  if (Math.abs(up) > 0.4) parts.push(`${up > 0 ? "crane up" : "crane down"} ${m(up)}`);
  if (!parts.length && a.target && b.target) {
    const t0 = sub(a.target, a.position), t1 = sub(b.target, b.position);
    const ang = ((Math.atan2(t1[0], t1[2]) - Math.atan2(t0[0], t0[2])) * 180) / Math.PI;
    const ad = ((ang + 540) % 360) - 180;
    if (Math.abs(ad) > 4) parts.push(`pan ${ad > 0 ? "right" : "left"} ${Math.round(Math.abs(ad))}°`);
  }
  if (Math.abs((b.focal_mm || 0) - (a.focal_mm || 0)) > 2) parts.push(`zoom ${b.focal_mm > a.focal_mm ? "in" : "out"}`);
  const s = parts.join(", ") || "static";
  return follow ? `${s === "static" ? "" : s + ", "}rides with the ${follow}`.replace(/^, /, "") : s;
}

const heightWord = (y) => (y == null ? "" : y < 0.9 ? "low" : y > 2.6 ? "high" : y < 1.3 ? "chest" : "eye level");
const SETUP_WORD = { master: "Master", wide: "Wide", single: "Single", single_a: "Single", single_b: "Single", ots: "Over the shoulder",
  ots_a: "Over the shoulder", ots_b: "Over the shoulder", two_shot: "Two-shot", insert: "Insert", pov: "POV", cu: "Close-up", ecu: "Extreme close-up" };

/**
 * The camera plan: one row per shot, numbered 12A, 12B... in strip order. Shots the book saw before that are gone from
 * the stage stay in the plan, struck through (dropped, never deleted). status: planned | shot | cut.
 */
export function cameraPlan(stage, { sceneNumber = "", page = null, renders = null, cutIds = null, order = null } = {}) {
  const shots = [...(stage?.shots || [])];
  if (order?.length) shots.sort((a, b) => (order.indexOf(a.id) + 1 || 1e6) - (order.indexOf(b.id) + 1 || 1e6));
  const actors = stage?.actors || [];
  const rows = shots.map((sh) => {
    const host = sh.camera_follow && actors.find((a) => a.id === sh.camera_follow);
    const wk = worldCameraKeys(stage, sh);
    const ks = [...(sh.camera_keys || [])].sort((a, b) => (a.frame || 0) - (b.frame || 0));
    const f0 = ks[0]?.focal_mm, f1 = ks[ks.length - 1]?.focal_mm;
    const y = host ? (ks[0]?.position?.[1] ?? null) : (wk[0]?.position?.[1] ?? null);
    const r = renders?.(sh.id) || {};
    const taken = Object.keys(r).some((k) => /draft|final/.test(k));   // a take exists: shot; and in the edit: cut
    const status = taken ? (cutIds?.has?.(sh.id) ? "cut" : "shot") : "planned";
    return { id: sh.id, name: sh.name || sh.id, setup: SETUP_WORD[sh.setup] || cap(String(sh.setup || "").replace(/_/g, " ")),
      lens: f0 == null ? "" : Math.abs((f1 ?? f0) - f0) > 1 ? `${Math.round(f0)}→${Math.round(f1)} mm` : `${Math.round(f0)} mm`,
      height: y == null ? "" : `${y.toFixed(1)} m${heightWord(y) ? ` (${heightWord(y)})` : ""}`,
      move: moveOf(host ? ks : wk, { follow: host ? (host.name || host.kind || "").toLowerCase() : null }),
      rig: host ? `vehicle mount (${host.name || host.kind})` : cap(sh.rig?.type && sh.rig.type !== "free" ? sh.rig.type : "free camera"),
      frames: ks.length ? `${ks.length} key${ks.length === 1 ? "" : "s"}` : "",
      status, dropped: !!page?.dropped?.[sh.id], gone: false, note: page?.shot_notes?.[sh.id] || "" };
  });
  const live = new Set(rows.map((r) => r.id));
  for (const [id, seen] of Object.entries(page?.shots_seen || {})) {
    if (!live.has(id)) rows.push({ ...seen, id, dropped: true, gone: true, status: "dropped", note: page?.shot_notes?.[id] || seen.note || "" });
  }
  // Numbers follow the order, dropped shots keep their place in the alphabet (12A, 12B struck, 12C).
  rows.forEach((r, i) => { r.letter = shotLetter(i); r.no = shotNumber(sceneNumber, i); });
  return rows;
}

/** Remember every shot the book has shown for a scene, so a shot removed from the stage stays in the strip, struck. */
export function rememberShots(book, sceneId, rows) {
  const p = scenePage(book, sceneId);
  for (const r of rows) if (!r.gone) p.shots_seen[r.id] = { name: r.name, setup: r.setup, lens: r.lens, height: r.height, move: r.move, rig: r.rig };
}

export function toggleDropped(book, sceneId, shotId) {
  const p = scenePage(book, sceneId);
  if (p.dropped[shotId]) delete p.dropped[shotId]; else p.dropped[shotId] = true;
  book.updated = now();
  return !!p.dropped[shotId];
}

// --------------------------------------------------------------------------------------------- rules auto-fill

const HOUR_WORD = (h) => (h == null ? "" : h < 5 ? "night" : h < 7 ? "dawn" : h < 10 ? "morning" : h < 16 ? "day" : h < 18.5 ? "late afternoon" : h < 20 ? "dusk" : "night");

export function lightingFacts(stage, sc) {
  const L = stage?.lighting || {}, env = stage?.environment || {};
  const bits = [];
  const tod = sc?.time ? cap(String(sc.time).toLowerCase()) : "";
  if (tod) bits.push(`${tod} (heading)`);
  if (L.preset) bits.push(`stage light: ${String(L.preset).replace(/_/g, " ")}`);
  else if (L.hour != null) bits.push(`sun at ${Math.floor(L.hour)}:${String(Math.round((L.hour % 1) * 60)).padStart(2, "0")} (${HOUR_WORD(L.hour)})`);
  if (stage?.sun) bits.push(stage.sun.elevation_deg < 0 ? "sun below the horizon" : `sun ${Math.round(stage.sun.elevation_deg)}° up, from ${Math.round(stage.sun.azimuth_deg)}°`);
  if (env.weather && env.weather !== "none") bits.push(`weather: ${env.weather}`);
  const lights = L.lights || [];
  if (lights.length) {
    const by = {};
    for (const l of lights) { const k = `${l.type || "light"}${l.kelvin ? ` ${l.kelvin}K` : ""}`; by[k] = (by[k] || 0) + 1; }
    bits.push("units: " + Object.entries(by).map(([k, n]) => `${n}× ${k}`).join(", "));
  }
  return bits.join(" · ");
}

/** Props, wardrobe and vehicles, with the other scenes each one is in (Kubrick-style continuity). */
export function continuityFacts(script, sc) {
  const items = [];
  const keys = ["props", "wardrobe", "vehicles", "animals"];
  const txt = (x) => String(typeof x === "string" ? x : x?.text || "").trim();
  for (const k of keys) for (const it of sc?.breakdown?.[k] || []) {
    const t = txt(it);
    if (!t) continue;
    const others = (script?.scenes || []).filter((o) => o.id !== sc.id && (o.breakdown?.[k] || []).some((x) => txt(x).toLowerCase() === t.toLowerCase())).map((o) => o.number);
    items.push(others.length ? `${t} (also in sc ${others.join(", ")})` : t);
  }
  return [...new Set(items)].join("; ");
}

/** What the rules know without the model: read off the script and the stage. Recomputed every time. */
export function autoFill(script, sc, stage, look = null) {
  if (!sc) return {};
  const out = {};
  const outline = sc.synopsis || sc.outline || "";
  if (outline) out.synopsis = outline;
  const ie = sc.int_ext === "INT" ? "Interior" : sc.int_ext === "EXT" ? "Exterior" : "";
  out.times = [ie && `${ie}, ${niceName(sc.location || "")}`, sc.time && niceName(sc.time)].filter(Boolean).join(" · ");
  const lk = [look?.description, look?.style_name || look?.style, look?.genre].filter((x) => typeof x === "string" && x.trim() && !/^(general|none|default|auto)$/i.test(x.trim()));
  if (lk.length) out.imagery = lk.join(". ");
  const lf = lightingFacts(stage, sc);
  if (lf) out.lighting = lf;
  const perf = {};
  for (const c of sc.characters || []) {
    const par = (sc.elements || []).filter((e) => e.type === "parenthetical" && e.character === c).map((e) => e.text.replace(/[()]/g, ""));
    const n = (sc.elements || []).filter((e) => e.type === "dialogue" && e.character === c).length;
    perf[c] = [n ? `${n} line${n === 1 ? "" : "s"}` : "no lines", par.length ? `marked ${par.join(", ")}` : ""].filter(Boolean).join("; ");
  }
  if (Object.keys(perf).length) out.performance = perf;
  const snd = [];
  for (const t of [...(sc.breakdown?.sound || []), ...(sc.breakdown?.music || []), ...(sc.breakdown?.sfx || [])]) {
    const s = String(typeof t === "string" ? t : t?.text || "").trim();
    if (s) snd.push({ hear: cap(s.replace(/^"|"$/g, "")), why: "" });
  }
  if (snd.length) out.sound = snd;
  const cont = continuityFacts(script, sc);
  if (cont) out.continuity = cont;
  return out;
}

const isEmpty = (v) => v == null || v === "" || (Array.isArray(v) && !v.length) || (typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length);

/** The page as shown: every field's value and where it came from (director / llm / rules / empty). */
export function pageFor(book, script, sc, stage, look = null, opts = {}) {
  const p = book.scenes[sc?.id] || {};
  const auto = autoFill(script, sc, stage, look);
  const fields = {};
  for (const f of [...FIELDS, { key: "constraints" }]) {
    const own = p[f.key];
    if (!isEmpty(own)) fields[f.key] = { value: own, source: p.src?.[f.key] || (p.edited?.[f.key] ? "director" : "llm") };
    else if (!isEmpty(auto[f.key])) fields[f.key] = { value: auto[f.key], source: "rules" };
    else fields[f.key] = { value: f.kind === "list" || f.kind === "sound" || f.key === "constraints" ? [] : f.kind === "perf" ? {} : "", source: "empty" };
  }
  // Characters in the scene always have a performance row (the model's note, else the rules' line count).
  const perf = { ...(auto.performance || {}), ...(fields.performance.source === "rules" ? {} : fields.performance.value) };
  fields.performance = { ...fields.performance, value: perf };
  const shots = stage ? cameraPlan(stage, { sceneNumber: sc?.number, page: p, ...opts }) : [];
  return { scene: sc, fields, shots, drafted: p.drafted || null, story_day: p.story_day || "" };
}

// --------------------------------------------------------------------------------------------- notes

let _nid = 0;
const noteId = () => `n_${now().toString(36)}_${(++_nid).toString(36)}`;

/** File placements from the server (/soundstage/book/place) into the book. Each keeps its raw text, why and confidence. */
export function addPlacements(book, placements, { source = "shorthand" } = {}) {
  const added = [];
  for (const p of placements || []) {
    const n = { id: p.id && !book.notes.some((x) => x.id === p.id) ? p.id : noteId(), text: String(p.text || "").trim(),
      scope: p.scope || "unsorted", scene_id: p.scene_id || null, line: Number.isInteger(p.line) ? p.line : null,
      character: p.character || null, category: p.category || "blocking", categories: p.categories || [p.category].filter(Boolean),
      confidence: typeof p.confidence === "number" ? p.confidence : 0, why: p.why || "", by: p.by || "rules", unknown: p.unknown || [],
      source, at: now() };
    if (!n.text) continue;
    book.notes.push(n);
    added.push(n);
  }
  book.updated = now();
  return added;
}

/** Move a note (drag to another scene / line, or to Unsorted). The director placed it: full confidence. */
export function moveNote(book, id, { scope, scene_id = null, line = null, category = null, character } = {}) {
  const n = book.notes.find((x) => x.id === id);
  if (!n) return null;
  if (scope) n.scope = scope;
  if (scope === "scene" || scene_id) { n.scope = "scene"; n.scene_id = scene_id; n.line = Number.isInteger(line) ? line : null; }
  if (scope === "unsorted" || scope === "global") { n.scene_id = null; n.line = null; }
  if (scope === "character") { n.scene_id = null; n.line = null; }
  if (category && CAT[category]) { n.category = category; n.categories = [category, ...(n.categories || []).filter((c) => c !== category)]; }
  if (character !== undefined) n.character = character;
  n.by = "director"; n.confidence = 1; n.why = "placed by the director";
  book.updated = now();
  return n;
}

export function removeNote(book, id) {
  const i = book.notes.findIndex((x) => x.id === id);
  if (i >= 0) book.notes.splice(i, 1);
  book.updated = now();
  return i >= 0;
}

export function editNote(book, id, text) {
  const n = book.notes.find((x) => x.id === id);
  if (n) { n.text = String(text || "").trim(); book.updated = now(); }
  return n;
}

/** Characters in a scene: its cue list plus anyone named in its action lines (Mara drives the car in sc 2). */
function sceneCast(script, sc) {
  const cast = new Set(sc?.characters || []);
  const t = (sc?.elements || []).map((e) => e.text).join(" ").toLowerCase();
  for (const c of script?.characters || []) {
    const al = String(c.name).toLowerCase().split(/\s+/).filter((w) => w.length >= 3 && !/^(deputy|sheriff|officer|the)$/.test(w));
    if (al.some((a) => new RegExp(`\\b${a}\\b`).test(t)) || (c.scenes || []).includes(sc?.id)) cast.add(c.name);
  }
  return cast;
}

/** A scene's notes: placed on it, plus standing character notes for the characters in it. */
export function notesForScene(book, script, sceneId) {
  const sc = script?.scenes?.find((x) => x.id === sceneId);
  const cast = sceneCast(script, sc);
  return book.notes.filter((n) => n.source !== "chat" && ((n.scope === "scene" && n.scene_id === sceneId) || (n.scope === "character" && cast.has(n.character))));
}
export const notesOnLine = (book, sceneId, line) => book.notes.filter((n) => n.scope === "scene" && n.scene_id === sceneId && n.line === line);
export const unsortedNotes = (book) => book.notes.filter((n) => n.scope === "unsorted");
export const globalNotes = (book) => book.notes.filter((n) => n.scope === "global");

/** Split a free-form outline (the director's shorthand) into notes: one per line or bullet; blank lines ignored. */
export function splitShorthand(text) {
  return String(text || "").split(/\r?\n/).map((l) => l.replace(/^\s*(?:[-*•·]|\d+[.)](?=\s))\s*/, "").trim()).filter((l) => l.length > 1);
}

// --------------------------------------------------------------------------------------------- living memory

const CTX_ORDER = ["subtext", "performance", "blocking", "camera", "lighting", "sound", "continuity"];
const short = (s, n = 160) => { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + "…"; };

/**
 * What the Director and Pitch assistants read before every command (mirror of soundstage/book/context.py):
 * {title, spine, statement, scene_id, scene, rules, notes, decisions, prompt: {style, constraints}, text}.
 */
export function getBookContext(book, script, sceneId = null) {
  book = normalizeBook(book, script);
  const pg = (sceneId && book.scenes[sceneId]) || {};
  const rules = [...book.rules.filter((r) => String(r).trim()), ...globalNotes(book).map((n) => n.text)];
  const notes = (sceneId ? notesForScene(book, script, sceneId) : [])
    .sort((a, b) => (CTX_ORDER.indexOf(a.category) + 1 || 99) - (CTX_ORDER.indexOf(b.category) + 1 || 99));
  const decisions = book.notes.filter((n) => n.source === "chat").slice(-5);
  const scene = {};
  for (const k of ["synopsis", "times", "imagery", "core", "subtext", "lighting", "pitfalls", "constraints", "performance"]) if (!isEmpty(pg[k])) scene[k] = pg[k];
  const style = [pg.imagery, ...book.style].filter(Boolean);
  const constraints = [...new Set([...(pg.constraints || []), ...book.constraints])];
  const L = [];
  if (book.spine) L.push(`Spine: ${short(book.spine, 120)}`);
  if (book.statement) L.push(`Approach: ${short(book.statement, 120)}`);
  if (pg.core) L.push(`This scene's core: ${short(pg.core, 120)}`);
  if (pg.subtext) L.push(`Subtext: ${short(pg.subtext, 120)}`);
  if (pg.imagery) L.push(`Imagery & tone: ${short(pg.imagery, 100)}`);
  if (constraints.length) L.push("Keep it: " + constraints.slice(0, 4).map((c) => short(c, 60)).join("; "));
  for (const r of rules.slice(0, 4)) L.push(`Rule: ${short(r, 100)}`);
  for (const n of notes.slice(0, 6)) L.push(`Note [${n.category || "note"}]${n.character ? ` (${niceName(n.character)})` : ""}: ${short(n.text, 100)}`);
  for (const d of decisions.slice(-2)) L.push(`Decided earlier: ${short(d.text, 90)}`);
  let text = L.join("\n");
  if (text.length > 900) text = text.slice(0, 899).trimEnd() + "…";
  return { title: book.title, spine: book.spine, statement: book.statement, scene_id: sceneId, scene, rules, notes, decisions,
    prompt: { style: style.slice(0, 3), constraints: constraints.slice(0, 4) }, text };
}

const TOOL_CAT = { lens: "camera", camera_move: "camera", shot: "camera", select_shot: "camera", rig: "camera", time: "lighting",
  light: "lighting", weather: "lighting", direct: "performance", move: "blocking", place: "blocking", add: "blocking", mount: "blocking",
  dismount: "blocking", sound: "sound", music: "sound", line: "sound", look: "lighting", style: "lighting" };

/**
 * The assistant writes back a decision made in chat as a note on the scene ("Decided earlier: ..." in every later
 * context). Only real changes: an undo, play or render isn't a decision. Returns the note, or null.
 */
export function recordDecision(book, { command, calls = [], results = [], sceneId = null, source = "chat" } = {}) {
  const text = String(command || "").trim();
  if (!text || /^(undo|redo|play|stop|yes|no)\b/i.test(text)) return null;
  const tools = (calls || []).map((c) => c.tool).filter((t, i) => (results[i]?.ok ?? true) && !["undo", "play", "frames", "render"].includes(t));
  if (!tools.length) return null;
  const cat = TOOL_CAT[tools.find((t) => TOOL_CAT[t])] || "blocking";
  const n = { id: noteId(), text, scope: sceneId ? "scene" : "global", scene_id: sceneId, line: null, character: null, category: cat,
    categories: [cat], confidence: 1, why: `decided in the Director chat (${tools.join(", ")})`, by: source, source: "chat", at: now() };
  book.notes.push(n);
  // Keep the chat's trail short: the 40 newest decisions.
  const chat = book.notes.filter((x) => x.source === "chat");
  if (chat.length > 40) { const drop = new Set(chat.slice(0, chat.length - 40).map((x) => x.id)); book.notes = book.notes.filter((x) => !drop.has(x.id)); }
  book.updated = now();
  return n;
}

// --------------------------------------------------------------------------------------------- revisions, lining

/** Lock a revision: a snapshot label, its colour, and what changed since the last one. */
export function addRevision(book, label = "") {
  const n = book.revisions.length;
  const prev = book.revisions[n - 1];
  const sig = revisionSig(book);
  const changed = prev ? Object.keys(sig).filter((k) => sig[k] !== prev.sig?.[k]) : Object.keys(sig);
  const r = { n: n + 1, colour: REV_COLOURS[n % REV_COLOURS.length], at: now(), label: String(label || "").trim() || (n ? `Revision ${n + 1}` : "First draft"),
    changed, sig };
  book.revisions.push(r);
  book.updated = now();
  return r;
}

function revisionSig(book) {
  const h = (s) => { let x = 0x811c9dc5; for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 0x01000193); } return (x >>> 0).toString(36); };
  const out = { front: h(JSON.stringify([book.spine, book.statement, book.rules, book.style])) };
  for (const [id, p] of Object.entries(book.scenes || {})) {
    const { drafted, shots_seen, ...rest } = p;   // eslint-disable-line no-unused-vars
    out[id] = h(JSON.stringify(rest) + JSON.stringify(book.notes.filter((n) => n.scene_id === id).map((n) => [n.text, n.line, n.category])));
  }
  return out;
}

/** The lined-script strip of a scene: story day, time of day, and each shot's status. */
export function linedStrip(page) {
  const rows = page?.shots || [];
  const count = (s) => rows.filter((r) => r.status === s && !r.dropped).length;
  return { story_day: page?.story_day || "", time: page?.scene?.time ? niceName(page.scene.time) : "",
    planned: rows.filter((r) => !r.dropped).length, shot: count("shot") + count("cut"), cut: count("cut"),
    dropped: rows.filter((r) => r.dropped).length };
}

// --------------------------------------------------------------------------------------------- Markdown

const mdList = (xs) => (xs || []).map((x) => `- ${x}`).join("\n");

/** The whole book as Markdown (pages = [pageFor(...)] in script order). */
export function toMarkdown(book, script, pages = []) {
  const out = [];
  out.push(`# ${book.title || script?.title || "Director's Book"}`, "");
  if (script?.author) out.push(`*Written by ${script.author}. Director's book made with Soundstage.*`, "");
  if (book.spine) out.push(`**Spine:** ${book.spine}`, "");
  if (book.statement) out.push(`**Director's statement:** ${book.statement}`, "");
  const rules = [...book.rules, ...globalNotes(book).map((n) => n.text)];
  if (rules.length) out.push("**Rules for the whole film**", "", mdList(rules), "");
  out.push("## Contents", "", ...pages.map((pg) => `- Scene ${pg.scene.number}: ${pg.scene.heading}`), "");
  for (const pg of pages) {
    const sc = pg.scene, F = pg.fields;
    out.push(`## Scene ${sc.number}: ${sc.heading}`, "");
    const ls = linedStrip(pg);
    out.push(`*${[ls.story_day && `Story day ${ls.story_day}`, ls.time, `${ls.planned} shots planned, ${ls.shot} shot, ${ls.cut} cut`].filter(Boolean).join(" · ")}*`, "");
    for (const f of FIELDS) {
      const v = F[f.key]?.value;
      if (isEmpty(v)) continue;
      out.push(`### ${f.label}`, "");
      if (f.kind === "text") out.push(String(v), "");
      else if (f.kind === "list") out.push(mdList(v), "");
      else if (f.kind === "perf") out.push(...Object.entries(v).map(([k, t]) => `- **${niceName(k)}:** ${t}`), "");
      else if (f.kind === "sound") out.push(...v.map((r) => `- We hear ${r.hear}${r.why ? `, because ${r.why}` : ""}`), "");
      if (f.key === "pitfalls" && F.constraints?.value?.length) out.push(`*In the prompts:* ${F.constraints.value.join("; ")}`, "");
    }
    if (pg.shots.length) {
      out.push("### Camera plan", "", "| No. | Shot | Lens | Height | Move | Rig | Status |", "|---|---|---|---|---|---|---|");
      for (const r of pg.shots) {
        const s = (t) => (r.dropped ? `~~${t}~~` : t);
        out.push(`| ${s(r.no)} | ${s(r.name)} | ${r.lens} | ${r.height} | ${r.move} | ${r.rig} | ${r.dropped ? "dropped" : r.status} |`);
      }
      out.push("");
    }
    const notes = notesForScene(book, script, sc.id);
    if (notes.length) {
      out.push("### Margin notes", "");
      for (const n of notes) {
        const line = Number.isInteger(n.line) ? sc.elements?.[n.line]?.text : null;
        out.push(`- **${CAT[n.category]?.label || n.category}**${n.character ? ` (${niceName(n.character)})` : ""}: ${n.text}${line ? `  \n  *at:* “${short(line, 90)}”` : ""}`);
      }
      out.push("");
    }
  }
  const uns = unsortedNotes(book);
  if (uns.length) out.push("## Unsorted notes", "", mdList(uns.map((n) => n.text)), "");
  if (book.revisions.length) {
    out.push("## Revision history", "", ...book.revisions.map((r) => `- ${r.n}. ${r.colour}: ${r.label} (${new Date(r.at).toISOString().slice(0, 16).replace("T", " ")})${r.changed?.length ? `, changed: ${r.changed.length}` : ""}`), "");
  }
  out.push("## About this book", "", "The template follows directors' binders:", "", ...SOURCES.map(([s, w]) => `- ${s}: ${w}`), "");
  return out.join("\n");
}
