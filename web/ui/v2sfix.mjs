// Video → 3D fail-safes (Mike 2026-11-02: "a button to regenerate if something went wrong, since it may take one or
// two tries" and "fix just the objects that are wrong, re-analysing the video for only those objects").
//   ↻ Regenerate      POST /soundstage/video2stage/regenerate: the same rebuild with a new seed. What you lock (the
//                     camera solve, the performer, the set) is reused from the last run on the server and kept from
//                     your current scene here (mergeLocked), so only the unlocked parts change.
//   Fix this object   POST /soundstage/video2stage/fix_object: SAM 3.1 re-tracks ONE object over the source frames and
//                     rebuilds it alone; it comes back as a new version of that actor (swapActor), with Undo.
//   Remove (not in the video) / Add a missed object (click it on a source frame).
// Pure functions first (tests/js/v2sfix.test.mjs), then the small lock dialog and the menu. No server calls here:
// web/soundstage.js runs the jobs (JobCard + the Activity bar).
import { icon } from "./icons.mjs";
import { openPopover } from "./popover.mjs";

export const LOCKS = [
  ["camera", "Keep the camera solve", "The camera move stays; the solve is not run again"],
  ["performer", "Keep the performer", "The motion capture stays; SAM 3D Body is not run again"],
  ["set", "Keep the set", "The set pieces and the set scan stay; the vision read is not run again"],
];
export const REGEN_LABEL = "↻ Regenerate";
const LOCK_KEY = "ss_v2s_locks";

/** Lock flags, always all three booleans. */
export function lockFlags(lock = {}) {
  return Object.fromEntries(LOCKS.map(([k]) => [k, !!lock?.[k]]));
}

/** A new seed for a regenerate: never 0 (the first build's) and never the last one. */
export function newSeed(last = 0, rand = Math.random) {
  const s = 1 + Math.floor(rand() * 2_000_000_000);
  return s === last ? s + 1 : s;
}

/** The POST body for ↻ Regenerate. last = the previous result ({tag, seed}); options = the chooser's. */
export function regenBody({ video, original = "", options = {}, last = {}, lock = {}, seed = null }) {
  return { ...options, video, original, tag: last.tag || undefined, seed: seed ?? newSeed(last.seed || 0), lock: lockFlags(lock) };
}

const isPerformer = (a) => !!a?.mocap;
const isSet = (a) => !!(a?.set_piece || a?.scan || a?.id === "v2s_backdrop" || a?.set_xform);
const isThing = (a) => !isPerformer(a) && !isSet(a);

/**
 * The regenerated scene with what was locked kept from the current one: the camera (every shot's keys + the
 * transform the rebuild used), the performer actor(s), the set (pieces + scan). Everything unlocked is the new run's.
 * Edits you made to a locked part survive, since they come from your scene, not the server's record.
 */
export function mergeLocked(cur, fresh, lock = {}) {
  const L = lockFlags(lock);
  const out = JSON.parse(JSON.stringify(fresh));
  const curA = cur?.actors || [];
  const keepIf = (pred) => curA.filter(pred).map((a) => JSON.parse(JSON.stringify(a)));
  let actors = out.actors || [];
  if (L.performer) actors = [...actors.filter((a) => !isPerformer(a)), ...keepIf(isPerformer)];
  if (L.set) actors = [...actors.filter((a) => !isSet(a)), ...keepIf(isSet)];
  // ids stay unique: a fresh actor that collides with a kept one gets a suffix
  const seen = new Set();
  out.actors = actors.map((a) => {
    let id = a.id, n = 2;
    while (seen.has(id)) id = `${a.id}_${n++}`;
    seen.add(id);
    return id === a.id ? a : { ...a, id };
  });
  if (L.camera && cur) {
    if (cur.shots) {
      const byId = new Map(cur.shots.map((s) => [s.id, s]));
      out.shots = (out.shots || []).map((s) => (byId.has(s.id) ? { ...s, camera_keys: JSON.parse(JSON.stringify(byId.get(s.id).camera_keys || [])) } : s));
    }
    if (cur.camera_keys) out.camera_keys = JSON.parse(JSON.stringify(cur.camera_keys));
    if (cur.video2stage?.xform) out.video2stage = { ...(out.video2stage || {}), xform: cur.video2stage.xform, solve: cur.video2stage.solve };
  }
  return out;
}

/** What a regenerate result reports for its stages, in words: "camera reused · set re-run · …". */
export function stagesLine(stages = {}) {
  const name = { depth: "depth", camera: "camera solve", mocap: "performer", breakdown: "set read" };
  return Object.entries(stages).map(([k, v]) => `${name[k] || k} ${v === "reused" ? "kept" : "re-run"}`).join(" · ");
}

/** Replace actor `next.id` with `next` (or add it when new). Returns {scene, previous} (previous = null when added). */
export function swapActor(scene, next) {
  const s = JSON.parse(JSON.stringify(scene));
  const i = (s.actors || []).findIndex((a) => a.id === next.id);
  const previous = i >= 0 ? s.actors[i] : null;
  if (i >= 0) s.actors[i] = JSON.parse(JSON.stringify(next));
  else (s.actors ||= []).push(JSON.parse(JSON.stringify(next)));
  return { scene: s, previous };
}

/** Take actor id out (and anything mounted on / carried by it). Returns {scene, removed}. */
export function removeActor(scene, id) {
  const s = JSON.parse(JSON.stringify(scene));
  const removed = (s.actors || []).filter((a) => a.id === id);
  s.actors = (s.actors || []).filter((a) => a.id !== id).map((a) => {
    const b = { ...a };
    if (b.mount_id === id) delete b.mount_id;
    if (b.carry_id === id) delete b.carry_id;
    return b;
  });
  return { scene: s, removed: removed[0] || null };
}

/** Undo for the fixes: a stack of whole scenes (the stage reloads one), newest last; a cap keeps memory small. */
export class FixUndo {
  constructor(cap = 20) { this.cap = cap; this.stack = []; }
  push(scene, label) { this.stack.push({ scene: JSON.parse(JSON.stringify(scene)), label }); if (this.stack.length > this.cap) this.stack.shift(); }
  get size() { return this.stack.length; }
  peek() { return this.stack[this.stack.length - 1] || null; }
  pop() { return this.stack.pop() || null; }
  clear() { this.stack = []; }
}

/** The Fix-this-object POST body. actor = the stage actor; pick = {sample, point:{x,y}} from a source-frame click. */
export function fixBody({ video, scene, actor = null, pick = null, mode = "fix", last = {}, seed = null }) {
  const v2s = scene?.video2stage || {};
  const body = { video, tag: last.tag || v2s.tag, mode, seed: seed ?? newSeed(), xform: v2s.xform || null,
    ids: (scene?.actors || []).map((a) => a.id) };
  if (actor) body.actor = actor;
  if (pick?.point) { body.point = { x: +pick.point.x, y: +pick.point.y }; body.sample = pick.sample | 0; }
  else if (pick && Number.isFinite(pick.sample)) body.sample = pick.sample | 0;
  if (actor) body.label = actor.source?.label || actor.name || actor.kind || "object";
  return body;
}

/** The source sample nearest a stage frame (samples are at reference.sample_times, in seconds). */
export function nearestSample(sampleTimes, frame, fps = 24) {
  const t = frame / fps;
  let best = 0;
  (sampleTimes || []).forEach((s, i) => { if (Math.abs(s - t) < Math.abs(sampleTimes[best] - t)) best = i; });
  return best;
}

/** A click on an object-fit:cover video (box w x h showing a vw x vh picture) -> 0-1 of the source picture. */
export function coverToSource(x, y, w, h, vw, vh) {
  const k = Math.max(w / Math.max(1, vw), h / Math.max(1, vh));
  const dx = (w - vw * k) / 2, dy = (h - vh * k) / 2;
  const u = (x - dx) / (vw * k), v = (y - dy) / (vh * k);
  return { x: Math.min(1, Math.max(0, u)), y: Math.min(1, Math.max(0, v)) };
}

/** Which fixes an actor of a rebuild offers (the menu and the compare bar). */
export function fixesFor(actor) {
  if (!actor || actor.mocap) return [];
  if (actor.id === "v2s_backdrop" || actor.scan) return [];
  return ["fix", "remove"];
}

// ------------------------------------------------------------------------------------------------ DOM
const CSS = `
.ss-v2f-menu { display:flex; flex-direction:column; gap:2px; padding:5px; min-width:220px; background:#1d1722; color:#f0efed;
  border:1px solid rgba(255,255,255,.14); border-radius:10px; box-shadow:0 16px 40px rgba(0,0,0,.5); font:12.5px/1.3 "Soundstage Grotesk", system-ui, sans-serif; }
.ss-v2f-menu button { display:flex; gap:7px; align-items:center; text-align:left; background:transparent; color:inherit; border:0; border-radius:7px; padding:7px 9px; cursor:pointer; font:inherit; }
.ss-v2f-menu button:hover, .ss-v2f-menu button:focus-visible { background:rgba(242,255,89,.1); outline:none; }
.ss-v2f-menu .d { color:#a9a3ad; font-size:11px; padding:2px 9px 4px; }
.ss-vi-modal .locks { display:flex; flex-direction:column; gap:6px; }
.ss-vi-modal .locks label { display:flex; gap:8px; align-items:flex-start; cursor:pointer; }
.ss-vi-modal .locks label span.d { display:block; color:#a9a3ad; font-size:11.5px; }
`;
let cssDone = false;
function ensureCss() {
  if (cssDone || typeof document === "undefined") return;
  cssDone = true;
  document.head.append(Object.assign(document.createElement("style"), { textContent: CSS }));
}

function savedLocks() {
  try { return lockFlags(JSON.parse(localStorage.getItem(LOCK_KEY) || "{}")); } catch { return lockFlags({ camera: true }); }
}
function saveLocks(l) { try { localStorage.setItem(LOCK_KEY, JSON.stringify(l)); } catch { /* private window */ } }

/** The ↻ Regenerate dialog: what to keep. Resolves {lock} or null (cancelled). */
export function chooseLocks({ initial = null } = {}) {
  ensureCss();
  return new Promise((resolve) => {
    const lock = lockFlags(initial || savedLocks());
    const wrap = Object.assign(document.createElement("div"), { className: "ss-vi-modal" });
    const card = Object.assign(document.createElement("div"), { className: "card" });
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-label", "Regenerate the rebuild");
    const h3 = document.createElement("h3");
    h3.append(icon("rotate-ccw", 16), "Regenerate with a new seed");
    const tip = Object.assign(document.createElement("div"), { className: "tip",
      textContent: "It can take one or two tries. Tick what came out right: it is kept and not run again, so only the rest is rebuilt." });
    const box = Object.assign(document.createElement("div"), { className: "locks" });
    for (const [k, label, d] of LOCKS) {
      const l = document.createElement("label");
      const c = Object.assign(document.createElement("input"), { type: "checkbox", checked: lock[k] });
      c.dataset.lock = k;
      c.addEventListener("change", () => { lock[k] = c.checked; });
      const t = document.createElement("span");
      t.append(Object.assign(document.createElement("b"), { textContent: label }), Object.assign(document.createElement("span"), { className: "d", textContent: d }));
      l.append(c, t);
      box.append(l);
    }
    const row = Object.assign(document.createElement("div"), { className: "row" });
    const cancel = Object.assign(document.createElement("button"), { type: "button", className: "cancel", textContent: "Cancel" });
    const go = Object.assign(document.createElement("button"), { type: "button", className: "go", textContent: REGEN_LABEL });
    go.dataset.act = "regen-go";
    const btns = Object.assign(document.createElement("div"), { className: "btns" });
    btns.append(cancel, go);
    row.append(Object.assign(document.createElement("span"), { className: "tip", textContent: "Depth is always reused (it has no seed)." }), btns);
    card.append(h3, tip, box, row);
    wrap.append(card);
    const done = (v) => { wrap.remove(); document.removeEventListener("keydown", key, true); resolve(v); };
    const key = (e) => { if (e.key === "Escape") { e.stopPropagation(); done(null); } };
    cancel.addEventListener("click", () => done(null));
    go.addEventListener("click", () => { saveLocks(lock); done({ lock: { ...lock } }); });
    wrap.addEventListener("pointerdown", (e) => { if (e.target === wrap) done(null); });
    document.addEventListener("keydown", key, true);
    document.body.append(wrap);
    go.focus();
  });
}

/** Open the right-click menu at a pointer event, in the pop-over layer. Returns the pop-over handle. */
export function openFixMenu(items, event, { theme = null } = {}) {
  let pop = null;
  const m = fixMenu(items, { onClose: () => pop?.close() });
  pop = openPopover(m, { anchor: event, theme, name: "v2sfix" });
  return pop;
}

/** The right-click menu over the 3D view for a rebuilt object: [{key, label, icon, tip, run}]. Returns the element. */
export function fixMenu(items, { onClose = null } = {}) {
  ensureCss();
  const m = Object.assign(document.createElement("div"), { className: "ss-v2f-menu" });
  m.setAttribute("role", "menu");
  for (const it of items) {
    if (it.note) { m.append(Object.assign(document.createElement("div"), { className: "d", textContent: it.note })); continue; }
    const b = Object.assign(document.createElement("button"), { type: "button", title: it.tip || "" });
    b.setAttribute("role", "menuitem");
    b.dataset.fix = it.key;
    if (it.icon) b.append(icon(it.icon, 13));
    b.append(it.label);
    b.addEventListener("click", () => { onClose?.(); it.run(); });
    m.append(b);
  }
  return m;
}

/** Fix this object's steps, for the job card until the server reports its own. */
export function fixPlan(mode = "fix") {
  return [
    { key: "queued", match: /^queued|waiting/i, label: "Waiting for the GPU", secs: 5 },
    { key: "track", match: /track|sam 3\.1/i, label: mode === "add" ? "Tracking the missed object over the clip (SAM 3.1)" : "Tracking only this object over the clip (SAM 3.1)", secs: 45 },
    { key: "build", match: /rebuild|photo|3d/i, label: "Rebuilding it alone (Photo → 3D)", secs: 90 },
    { key: "swap", match: /swap|done/i, label: "Swapping it in", secs: 2 },
  ];
}

/** The Activity bar's name for a GPU prompt one of these jobs is waiting on. */
export function activityName(kind, what, label = "") {
  const k = kind === "fix" ? `Video → 3D · fix ${label || "object"}` : kind === "regenerate" ? "Video → 3D · regenerate" : "Video → 3D";
  return what ? `${k}: ${what}` : k;
}
