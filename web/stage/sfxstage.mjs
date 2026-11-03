// Soundstage practical effects on the stage (sfx.mjs): installSfx(Stage, deps) wires the SFX rigs into the Stage.
//
//  - Rigs are actors of kind sfx_<kind> (a mortar pot, a fire bar, a squib, a candy-glass pane, a blood pack on a
//    person's wardrobe...). Their markers show while you block the scene and are hidden in every capture, the depth
//    pass and the ID matte; only a breakaway pane is in the shot (it is a real prop until it shatters).
//  - Simulate & bake applies every explosion's blast to every body (physics.mjs opts.blasts). A contact trigger needs the
//    bake's hits, so the bake runs again (from the authored keys) while new contact fires turn up (at most 3 passes).
//    The bake writes scene.physics.sfx (fires, what caught fire, what each blast did, scorch, wounds) for the prompt
//    compiler (soundstage/look/sfx.py) and the A2 sounds.
//  - Every frame: the fireball, smoke, sparks, squib hits and stage blood go through the one particle system
//    (secondary.mjs), plus the practical light, the scorch marks, the wounds and the hit reactions. All of it is a pure
//    function of the scene and the frame, so scrubbing back before a cue shows the untouched originals.
//  - Fire: K (or the panel's big Fire button) at the playhead records the cue as a key on the selected rig (or the next
//    armed manual one); in Drive mode K during REC records it into the take. Reset to before disarms the rig and puts
//    everything it touched back exactly as it was (one Undo step); A/B swaps between the last two runs.
import * as THREE from "../vendor/three.module.min.mjs";
import * as X from "./sfx.mjs";
import { materialOf } from "./impacts.mjs";
import { unbakeActor, worldRole } from "./world.mjs";
import { groundPresetFor } from "./particles.mjs";

const MARKER_COLORS = { explosion: "#e0522a", fire: "#ff8a2a", sparks: "#ffd25a", squib: "#c9c9c9", smoke_bomb: "#8a8f99", breakaway_glass: "#a9d8ea",
  flare: "#ff3b30", body_squib: "#b0121b", stab: "#b0121b" };
const BAKE_KEYS = ["events", "fps", "frames", "baked", "setTracks", "takeovers"];   // what a bake writes on scene.physics
const clone = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));
const BLOOD = new THREE.Color(0.32, 0.015, 0.02);

/** The marker a rig shows on the stage (never in a capture): a small, plainly-labelled practical-effects prop. */
function buildMarker(kind) {
  const g = new THREE.Group(), col = new THREE.Color(MARKER_COLORS[kind] || "#cccccc");
  const mat = new THREE.MeshStandardMaterial({ color: col, roughness: 0.6, emissive: col, emissiveIntensity: 0.25 });
  mat.allowOverride = false;   // the marker keeps its colour in Clay (it is never in a capture)
  const add = (geo, x = 0, y = 0, z = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.userData.sfxMarker = true; g.add(m); return m; };
  if (kind === "explosion") { add(new THREE.CylinderGeometry(0.16, 0.2, 0.32, 14), 0, 0.16); add(new THREE.TorusGeometry(0.3, 0.02, 6, 24), 0, 0.02).rotation.x = Math.PI / 2; }
  else if (kind === "fire") add(new THREE.BoxGeometry(0.6, 0.06, 0.08), 0, 0.03);
  else if (kind === "sparks") add(new THREE.ConeGeometry(0.08, 0.18, 10), 0, 0.09).rotation.x = Math.PI;
  else if (kind === "squib") add(new THREE.SphereGeometry(0.05, 10, 8), 0, 0.05);
  else if (kind === "smoke_bomb") add(new THREE.CylinderGeometry(0.07, 0.07, 0.16, 12), 0, 0.08);
  else if (kind === "flare") add(new THREE.CylinderGeometry(0.02, 0.02, 0.3, 8), 0, 0.03).rotation.z = Math.PI / 2;
  else if (kind === "body_squib" || kind === "stab") add(new THREE.SphereGeometry(0.035, 10, 8));
  if (kind === "breakaway_glass") {
    // The pane itself is a real prop: in the shot until it breaks.
    const pm = new THREE.MeshStandardMaterial({ color: 0xbfe3f0, transparent: true, opacity: 0.32, roughness: 0.05, metalness: 0, depthWrite: false });
    pm.allowOverride = false;   // reads as glass in Clay too (like vehicle glass)
    const pane = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.6, 0.012), pm);
    pane.position.y = 0.9; pane.userData.sfxPane = true; pane.userData.glass = true; g.add(pane);
    const frame = new THREE.Mesh(new THREE.BoxGeometry(1.26, 0.04, 0.05), mat); frame.position.y = 0.08; frame.userData.sfxMarker = true; g.add(frame);
  }
  g.userData.sfxMarkerGroup = true;
  return g;
}

export function installSfx(Stage, deps) {
  const { LIBRARY, NO_COLLIDE, PERSON_KINDS } = deps;
  for (const [k, v] of Object.entries(X.SFX_KINDS)) {
    const kind = X.SFX_PREFIX + k;
    if (!LIBRARY[kind]) LIBRARY[kind] = { label: `SFX: ${v.label}`, height: v.height, rig: "static", sfx: true };
    NO_COLLIDE.add(kind);
  }
  const P = Stage.prototype;

  // ---------- the rigs ----------
  P._sfxRigs = function () { return (this.state?.actors || []).filter((a) => X.isSfxRig(a)); };
  P._sfxPersonOf = function (id) { return this.state.actors.find((x) => x.id === id && PERSON_KINDS.has(x.kind)) || null; };
  /** Where a rig is at frame f (on a person: the wardrobe point). */
  P._sfxPosAt = function (a, f = 0) {
    const s = X.sfxOf(a);
    if (s && X.SFX_KINDS[s.kind].onActor && s.target) { const pt = this._sfxPointAt(a, f); if (pt) return pt.pos; }
    return this._actorPosAt(a, f);
  };
  /** A body squib's or stab's wardrobe point at frame f: {pos, normal} in the world. */
  P._sfxPointAt = function (a, f) {
    const s = X.sfxOf(a), who = s?.target && this._sfxPersonOf(s.target);
    if (!who) return null;
    const p = this._actorPosAt(who, f), yaw = this._headingAt(who, f), H = (who.height_m || LIBRARY[who.kind]?.height || 1.8) * (who.scale || 1);
    const L = X.bodyPointLocal(s.point, H), c = Math.cos(yaw), si = Math.sin(yaw);
    const rot = (v) => [v[0] * c + v[2] * si, v[1], -v[0] * si + v[2] * c];
    const q = rot(L.pos);
    return { pos: [p[0] + q[0], (p[1] || 0) + q[1], p[2] + q[2]], normal: rot(L.normal) };
  };
  /** Things that burn: [{id, pos, half, material, at(frame)}] (props of wood, cardboard, fabric or plastic). */
  P._sfxFlammables = function () {
    const out = [];
    for (const a of this.state.actors) {
      if (X.isSfxRig(a) || PERSON_KINDS.has(a.kind) || worldRole(a) === "vehicle" || a.mount_id || a.carry_id) continue;
      const m = a.physics?.material === "fabric" ? "fabric" : materialOf(a);
      if (!X.FLAMMABLE[m]) continue;
      const g = this.actorMeshes.get(a.id), box = g && this._localBox(g);
      if (!box) continue;
      const at = (f) => { const p = this._actorPosAt(a, f); return [p[0] + box.center[0], (p[1] || 0) + box.center[1], p[2] + box.center[2]]; };
      out.push({ id: a.id, pos: at(0), half: [...box.half], material: m, at });
    }
    return out;
  };
  /** The first frame something solid comes within a contact rig's reach (or the watched object does). */
  P._sfxProximity = function (a, s) {
    const last = this._lastFrame(), p = this._actorPosAt(a, 0), reach = Math.max(0.6, s.radius) + 0.25;
    const who = this.state.actors.filter((x) => !X.isSfxRig(x) && x.id !== a.id && (s.trigger.watch ? x.id === s.trigger.watch : true)
      && (PERSON_KINDS.has(x.kind) || worldRole(x) || x.physics?.mode === "dynamic" || x.physics?.baked));
    for (let f = 0; f <= last; f++) for (const x of who) {
      const q = this._actorPosAt(x, f);
      if (Math.hypot(q[0] - p[0], q[2] - p[2]) <= reach && Math.abs((q[1] || 0) - (p[1] || 0)) < 2.5) return f;
    }
    return null;
  };

  /** Fires, burns, wounds etc. for the scene as it is now (cached on the rigs, the bake's hits and the edit generation). */
  P._sfxState = function () {
    const rigs = this._sfxRigs();
    if (!rigs.length) return null;
    const fps = this.state.shot?.fps || 24, frames = this._lastFrame() + 1, ev = this.state.physics?.events || [];
    const key = JSON.stringify([this._sfxGen || 0, frames, fps, rigs.map((a) => [a.id, a.sfx, a.keys, a.position]), ev.length, ev[0]?.t, ev[ev.length - 1]?.t]);
    if (this._sfxCache?.key === key) return this._sfxCache.v;
    const posOf = (a) => this._actorPosAt(a, 0);
    const fires = X.resolveFires(rigs, { fps, frames, events: ev, posOf, proximity: (a, s) => (s.trigger.type === "contact" ? this._sfxProximity(a, s) : null) });
    const flammables = this._sfxFlammables();
    const burning = X.burnSchedule(rigs, fires, flammables, { fps, frames, posOf });
    const hits = X.bodyHits(rigs, fires);
    const scorch = X.scorchMarks(rigs, fires, { posOf, burning, flammables });
    const v = { rigs, fires, flammables, burning, hits, scorch, fps, frames, posOf };
    this._sfxCache = { key, v };
    return v;
  };

  /** Keep scene.physics.sfx (what the compiler reads) in step with the rigs; no rigs: no record (and no new physics object). */
  P._sfxSyncRecord = function () {
    const S = this._sfxState();
    if (!S) { if (this.state?.physics?.sfx) delete this.state.physics.sfx; return; }
    const prev = this.state.physics?.sfx || {};
    const wounds = X.woundsAt(S.rigs, S.fires, S.frames - 1, { fps: S.fps });
    const rec = X.sfxRecord(S.fires, { burning: S.burning, affected: prev.affected || [], scorch: S.scorch, wounds });
    if (prev.pristine !== undefined) rec.pristine = prev.pristine;
    this.state.physics = { ...(this.state.physics || {}), sfx: rec };
  };
  const toJSON0 = P.toJSON;
  P.toJSON = function () { try { this._sfxSyncRecord(); } catch (err) { console.warn("Soundstage SFX", err); } return toJSON0.call(this); };
  const record0 = P._record;
  P._record = function () { this._sfxGen = (this._sfxGen || 0) + 1; return record0.call(this); };
  const restore0 = P._restore;
  P._restore = function (snap) { this._sfxGen = (this._sfxGen || 0) + 1; return restore0.call(this, snap); };
  const load0 = P.load;
  P.load = function (scene) { this._sfxGen = (this._sfxGen || 0) + 1; this._sfxAB = null; return load0.call(this, scene); };

  // A scene with an armed explosion counts as baked: an edit re-bakes it by itself (world.mjs rebaker), from the
  // authored keys, so one changed setting never lands on top of the last result.
  const hasBake0 = P._hasBake;
  P._hasBake = function () { return hasBake0.call(this) || this._sfxRigs().some((a) => { const s = X.sfxOf(a); return s.armed && s.kind === "explosion"; }); };

  // ---------- the bake ----------
  const sim0 = P.simulatePhysics;
  P.simulatePhysics = function (opts = {}) {
    const rigs = this._sfxRigs();
    if (!rigs.length || opts.blasts) return sim0.call(this, opts);
    const fps = this.state.shot?.fps || 24, frames = this._lastFrame() + 1, posOf = (a) => this._actorPosAt(a, 0);
    // The pristine scene, the first time an SFX bake lands on an unbaked scene: Reset to before puts it back exactly.
    let pristine = this.state.physics?.sfx?.pristine ?? null;
    if (pristine == null && !hasBake0.call(this)) {
      const { sfx, ...ph } = this.state.physics || {};
      pristine = JSON.stringify({ physics: this.state.physics ? ph : null, actors: this.state.actors.filter((a) => !X.isSfxRig(a)) });
    }
    const before = JSON.stringify(this.state);
    const proximity = (a, s) => (s.trigger.type === "contact" ? this._sfxProximity(a, s) : null);
    let fires = X.resolveFires(rigs, { fps, frames, events: [], posOf, proximity }), r = null, sig = "";
    for (let pass = 0; pass < 3; pass++) {
      const blasts = X.blastsFrom(rigs, fires, { posOf });
      if (pass) this._mergeRec = true;   // the extra passes are the same edit (one Undo)
      r = sim0.call(this, { ...opts, blasts });
      sig = JSON.stringify(fires);
      const next = X.resolveFires(rigs, { fps, frames, events: this.state.physics?.events || [], posOf, proximity });
      if (JSON.stringify(next) === sig) break;
      fires = next;
    }
    const res = this._lastSim, blasted = res?.blasted || {}, tk = res?.takeovers || {};
    // What each blast did, for the prompt: flips, rolls, rocks, thrown, knocked down, falls, breaks.
    const affected = [];
    for (const [id, dv] of Object.entries(blasted)) {
      const aid = String(id).split("#")[0].split("~")[0], a = this.state.actors.find((x) => x.id === aid);
      if (!a || affected.some((x) => x.id === aid)) continue;
      const by = tk[id]?.by || X.blastsFrom(rigs, fires, { posOf }).map((b) => b.id)[0];
      affected.push({ id: aid, by, dv, how: X.blastOutcome({ kind: a.kind, role: worldRole(a), keys: a.keys, broke: !!a.physics?.fracture, dv }) });
    }
    this.state.physics = { ...(this.state.physics || {}) };
    this._sfxCache = null;
    this._sfxSyncRecord();
    this.state.physics.sfx.affected = affected;
    if (pristine != null) this.state.physics.sfx.pristine = pristine;
    // A/B: A is the previous run as it came out of its bake (or the scene before this one, the first time).
    this._sfxAB = { a: this._sfxAB?.b || before, b: JSON.stringify(this.state), showing: "b" };
    // A bake that ran recorded its undo step inside sim0 (onChange): the record above belongs to that step.
    // (Not while recording is muted: a Presets card records its own step afterwards.)
    if (this._muteRecord) this._mergeRec = false;
    else if (r?.ok !== false && this._hist?.length) this._hist[this._hist.length - 1] = JSON.stringify(this.state);
    const nF = fires.length;
    const words = affected.length ? ` The blast: ${affected.slice(0, 4).map((x) => `${this.state.actors.find((a) => a.id === x.id)?.name || x.id} ${x.how}`).join(", ")}.` : "";
    const burn = Object.keys(this.state.physics.sfx.burning || {}).length;
    const msg = `${nF} SFX cue${nF === 1 ? "" : "s"} (${fires.map((f) => `${rigs.find((a) => a.id === f.id)?.name || f.id} at ${f.t.toFixed(1)} s`).slice(0, 4).join(", ")}).${words}${burn ? ` ${burn} thing${burn > 1 ? "s" : ""} caught fire.` : ""}`;
    if (r && !r.ok) { this.setFrame(this.frame); this.onChange(this.toJSON()); return { ok: true, sfx: true, fires, message: msg }; }
    return { ...r, fires, sfx: true, message: `${r?.message || ""} ${msg}`.trim() };
  };

  // ---------- editing ----------
  /** Add a rig (kind from SFX_KINDS): {position, target (a person, for body squibs and stabs), point, sfx}. Returns the actor. */
  P.addSfxRig = function (kind, o = {}) {
    if (!X.SFX_KINDS[kind]) return null;
    const cam = this._cameraAt?.(this.frame) || {}, tgt = cam.target || [0, 0, 0];
    const n = this._sfxRigs().filter((a) => X.sfxKindOf(a) === kind).length + 1;
    const id = o.id && !this.state.actors.some((x) => x.id === o.id) ? o.id : `sfx_${kind}_${Date.now().toString(36)}${n}`;
    const sfx = { trigger: { type: "time", at: +(Math.min(this._lastFrame() / (this.state.shot?.fps || 24) - 0.5, Math.max(0.5, this.frame / (this.state.shot?.fps || 24) || 1))).toFixed(2) }, ...(o.sfx || {}) };
    if (X.SFX_KINDS[kind].onActor) {
      const sel = this.state.actors.find((x) => x.id === (o.target || this.selected) && PERSON_KINDS.has(x.kind)) || this.state.actors.find((x) => PERSON_KINDS.has(x.kind));
      if (!sel) return null;
      sfx.target = sel.id; sfx.point = o.point || sfx.point || (kind === "stab" ? "belly" : "chest");
    }
    const a = X.makeRig(kind, { id, name: o.name || `${X.SFX_KINDS[kind].label}${n > 1 ? ` ${n}` : ""}`, position: o.position || [tgt[0], kind === "sparks" ? 2.4 : 0, tgt[2]], sfx });
    this.state.actors.push(a);
    this._buildSet();
    this._sfxCache = null;
    this.setFrame(this.frame);
    this.onChange(this.toJSON());
    if (X.SFX_KINDS[kind].physical && this.state.physics?.autoBake !== false) this.simulatePhysics();
    return a;
  };
  /** Change a rig's settings (patch merged into a.sfx; trigger merged too). Re-bakes from the authored scene by itself. */
  P.setSfx = function (id, patch = {}) {
    const a = this.state.actors.find((x) => x.id === id && X.isSfxRig(x));
    if (!a) return null;
    const t = patch.trigger ? { ...(a.sfx?.trigger || {}), ...patch.trigger } : a.sfx?.trigger;
    const wasLive = X.sfxOf(a).armed && X.SFX_KINDS[X.sfxKindOf(a)]?.physical;
    a.sfx = { ...(a.sfx || {}), ...patch, ...(t ? { trigger: t } : {}) };
    // Disarming an explosion is Reset to before for it: the set it blasted goes back (one Undo step, its settings kept).
    if (wasLive && !X.sfxOf(a).armed) { this.sfxReset([a.id]); return X.sfxOf(a); }
    this._sfxCache = null;
    this.setFrame(this.frame);
    this.onChange(this.toJSON());
    return X.sfxOf(a);
  };
  /** The rig the Fire button fires: the selected rig, else the first armed one on a manual cue, else the first armed one. */
  P.sfxCueRig = function () {
    const rigs = this._sfxRigs().filter((a) => X.sfxOf(a).armed);
    return rigs.find((a) => a.id === this.selected) || rigs.find((a) => X.sfxOf(a).trigger.type === "manual") || rigs[0] || null;
  };
  /** Record a manual fire at `frame` on a rig (no undo step, no redraw with silent: Drive mode's kept take does one). */
  P.sfxRecordFire = function (id, frame, { silent = false } = {}) {
    const a = this.state.actors.find((x) => x.id === id && X.isSfxRig(x));
    if (!a) return null;
    a.sfx = X.recordManualFire(a, frame);
    this._sfxCache = null;
    if (!silent) { this.setFrame(this.frame); this.onChange(this.toJSON()); }
    return a.sfx;
  };
  /** Fire! (K, the panel's Fire button): the cue rig fires at the playhead, written down as a key (one Undo step). */
  P.sfxFire = function (id = null) {
    const a = id ? this.state.actors.find((x) => x.id === id && X.isSfxRig(x)) : this.sfxCueRig();
    if (!a) { this.onInteract?.("No SFX rig to fire: add one (Physics panel → SFX)."); return null; }
    this.sfxRecordFire(a.id, this.frame);
    const t = this.frame / (this.state.shot?.fps || 24);
    this.onInteract?.(`💥 ${a.name} fired at ${t.toFixed(2)} s (recorded as its cue; Undo takes it back).`);
    return { id: a.id, frame: this.frame, t };
  };

  /**
   * Reset to before: the rig is disarmed (its settings kept) and everything it touched goes back exactly as it was:
   * re-baked from the authored keys without it, or (nothing else to bake) the scene from before the first SFX bake.
   * One Undo step. ids: rig ids (default: every rig).
   */
  P.sfxReset = function (ids = null) {
    const rigs = this._sfxRigs().filter((a) => !ids || ids.includes(a.id));
    if (!rigs.length) return null;
    for (const a of rigs) a.sfx = { ...(a.sfx || {}), armed: false };
    this._sfxCache = null;
    const pristine = this.state.physics?.sfx?.pristine;
    const others = this._sfxRigs().some((a) => { const s = X.sfxOf(a); return s.armed && s.kind === "explosion"; });
    const dyn = this.state.actors.some((a) => a.physics?.mode === "dynamic");
    // The first SFX bake landed on a scene that was already baked (a crash, a ram): no pristine copy was kept, and that
    // bake has to come back, so re-bake from the authored keys without the disarmed rigs.
    const priorBake = pristine == null && !!this.state.physics?.baked;
    if (others || dyn || priorBake) {
      const r = this.simulatePhysics();
      return { ok: true, message: `Reset to before: ${rigs.map((a) => a.name).join(", ")} disarmed; re-baked from the untouched scene. ${r?.message || ""}`.trim() };
    }
    // Nothing else bakes: every baked object goes back to its authored keys, position and physics (from the pristine
    // copy when it has one), and everything else about it (its name, colour, wardrobe...) stays as it is now. The
    // scene's physics keeps its settings (ground type, shake...); only what the bake wrote goes.
    const P0 = pristine ? JSON.parse(pristine) : { actors: [], physics: null };
    const keep = new Map(P0.actors.map((a) => [a.id, a]));
    this.state.actors = this.state.actors.map((a) => {
      if (X.isSfxRig(a) || !a.physics?.baked) return a;
      const b = clone(a), p0 = keep.get(a.id);
      unbakeActor(b);
      if (!p0) return b;
      // The authored state as it was before the blast (unless the authored keys were edited since), in its key order.
      if (JSON.stringify(b.keys) === JSON.stringify(p0.keys)) for (const k of ["keys", "position", "physics"]) { if (p0[k] === undefined) delete b[k]; else b[k] = clone(p0[k]); }
      const out = {};
      for (const k of Object.keys(p0)) if (k in b) out[k] = b[k];
      for (const k of Object.keys(b)) if (!(k in out)) out[k] = b[k];
      return out;
    });
    const ph = { ...(this.state.physics || {}) }, ph0 = P0.physics || {};
    for (const k of BAKE_KEYS) { if (ph0[k] === undefined) delete ph[k]; else ph[k] = clone(ph0[k]); }
    this.state.physics = ph;
    if (this.state.physics?.sfx) { delete this.state.physics.sfx.pristine; this.state.physics.sfx.affected = []; }
    this._bakeSig = null;
    this._sfxCache = null;
    this._sfxGen = (this._sfxGen || 0) + 1;
    this.setFrame(this.frame);
    this.onChange(this.toJSON());
    return { ok: true, message: `Reset to before: ${rigs.map((a) => a.name).join(", ")} disarmed; every object it touched is back as it was.` };
  };
  /** Deleting an armed explosion takes its blast with it: the set is reset to before it, in the same Undo step. */
  const removeSelected0 = P.removeSelected;
  P.removeSelected = function () {
    const a = this.state.actors.find((x) => x.id === this.selected && X.isSfxRig(x));
    if (a && X.sfxOf(a).armed && X.SFX_KINDS[X.sfxKindOf(a)]?.physical) {
      const mute = this._muteRecord, sel = this.selected;
      this._muteRecord = true;
      try { this.sfxReset([a.id]); } finally { this._muteRecord = mute; }
      this.selected = sel;
    }
    return removeSelected0.call(this);
  };
  /** Reset to before, from an affected object: every rig whose blast, fire or wound touched it. */
  P.sfxResetObject = function (id) {
    const rec = this.state.physics?.sfx || {};
    const by = new Set();
    for (const x of rec.affected || []) if (x.id === id && x.by) by.add(x.by);
    for (const [bid, b] of Object.entries(rec.burning || {})) if (bid === id) { let c = b.by, guard = 0; while (c && rec.burning[c] && guard++ < 50) c = rec.burning[c].by; if (c) by.add(c); }
    for (const w of rec.wounds || []) if (w.target === id) by.add(w.rig);
    if (!by.size) return null;
    return this.sfxReset([...by]);
  };
  /** A/B: swap between the previous run and the new one (not an Undo step). Returns "a" | "b" | null. */
  P.sfxCompare = function () {
    const ab = this._sfxAB;
    if (!ab) return null;
    const now = JSON.stringify(this.state);
    if (now !== (ab.showing === "a" ? ab.a : ab.b)) { this._sfxAB = null; return null; }   // edited since: the pair is stale
    ab.showing = ab.showing === "a" ? "b" : "a";
    this._restore(ab.showing === "a" ? ab.a : ab.b);
    this._sfxAB = ab;
    return ab.showing;
  };

  /** What the panel shows for a rig: settings, its fires, the people it can go on. */
  P.sfxInfo = function (id) {
    const a = this.state.actors.find((x) => x.id === id && X.isSfxRig(x));
    if (!a) return null;
    const S = this._sfxState(), s = X.sfxOf(a);
    return { id, name: a.name, kind: s.kind, label: X.SFX_KINDS[s.kind].label, sfx: s, fires: (S?.fires || []).filter((f) => f.id === id),
      people: this.state.actors.filter((x) => PERSON_KINDS.has(x.kind)).map((x) => [x.id, x.name || x.kind]),
      objects: this.state.actors.filter((x) => !X.isSfxRig(x)).map((x) => [x.id, x.name || x.kind]),
      rigs: this._sfxRigs().filter((x) => x.id !== id).map((x) => [x.id, x.name]), ab: this._sfxAB?.showing || null,
      affected: (this.state.physics?.sfx?.affected || []).filter((x) => x.by === id) };
  };

  // ---------- every frame ----------
  const emitters0 = P._secondaryEmitters;
  P._secondaryEmitters = function () {
    const em = emitters0.call(this);
    const S = this._sfxState();
    if (!S || !S.fires.length && !Object.keys(S.burning).length) return em;
    const env = this.state.environment || {};
    const ground = groundPresetFor(env.set, env.weather, this.state.physics?.ground);
    em.push(...X.sfxEmitters(S.rigs, S.fires, { fps: S.fps, frames: S.frames, posOf: S.posOf, ground, burning: S.burning, flammables: S.flammables,
      pointOf: (a, f) => this._sfxPointAt(a, f) }));
    return em;
  };

  // The hit reactions are undone before the stage poses the people for a new frame: the stage only sets the heading
  // (rotation.y), so a lean or roll left on the group would otherwise carry into the next frame and add up.
  const setFrame0 = P.setFrame;
  P.setFrame = function (...args) { try { this._sfxUndoPeople?.(); } catch (err) { console.warn("Soundstage SFX", err); } return setFrame0.apply(this, args); };

  const sec0 = P._secondaryAt;
  P._secondaryAt = function (frame) {
    sec0.call(this, frame);
    if (this._softSampling) return;
    try { this._sfxAt(frame); } catch (err) { console.warn("Soundstage SFX", err); }
  };

  P._sfxAt = function (frame) {
    const S = this._sfxState();
    const fx = this._sfxFx;
    if (!S) { if (fx) fx.group.visible = false; this._sfxUndoPeople(); return; }
    if (!this._sfxFx || this._sfxFx.group.parent !== this.root) {
      if (!this._sfxFx) {
        const group = new THREE.Group(); group.userData.sfxFx = true;
        const lights = [0, 1].map(() => { const l = new THREE.PointLight(0xffa060, 0, 30, 2); l.userData.impactFlash = true; group.add(l); return l; });
        this._sfxFx = { group, lights, scorch: new Map(), wounds: new Map() };
      }
      this.root.add(this._sfxFx.group);
    }
    const F = this._sfxFx;
    F.group.visible = true;
    // Rig markers (and body rigs ride their wardrobe point).
    for (const a of S.rigs) {
      const g = this.actorMeshes.get(a.id);
      if (!g) continue;
      const kind = X.sfxKindOf(a);
      if (!g.userData.sfxMarker) {
        for (const c of g.children) c.visible = false;
        g.userData.sfxMarker = buildMarker(kind);
        g.userData.sfxMarker.traverse((o) => { o.userData.actorId = a.id; });   // a click on the marker selects the rig
        g.add(g.userData.sfxMarker);
      }
      if (X.SFX_KINDS[kind].onActor) { const pt = this._sfxPointAt(a, frame); if (pt) g.position.set(...pt.pos); }
      const fired = S.fires.find((f) => f.id === a.id && f.frame <= frame);
      g.userData.sfxMarker.traverse((o) => {
        if (o.userData.sfxPane) o.visible = !fired;
        else if (o.userData.sfxMarker && X.SFX_KINDS[kind].onActor) o.visible = !fired;   // after the hit the wound shows, not the rig
      });
    }
    // Practical light.
    const L = X.sfxLightsAt(S.rigs, S.fires, frame, { fps: S.fps, posOf: S.posOf, burning: S.burning, flammables: S.flammables });
    F.lights.forEach((l, i) => {
      const x = L[i];
      l.intensity = x ? x.intensity : 0;
      if (x) { l.position.set(x.pos[0], Math.max(0.3, x.pos[1]), x.pos[2]); l.color.setRGB(...x.color); }
    });
    // Scorch marks (from their frame on).
    for (const m of S.scorch) {
      let d = F.scorch.get(m.id);
      if (!d) {
        d = new THREE.Mesh(new THREE.CircleGeometry(1, 28), new THREE.MeshStandardMaterial({ color: 0x141210, transparent: true, opacity: 0.78, roughness: 1, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
        d.material.allowOverride = false;   // the scorch shows in the Clay guide too
        d.rotation.x = -Math.PI / 2; d.userData.glass = true; d.userData.noCollide = true; F.group.add(d); F.scorch.set(m.id, d);
      }
      d.position.set(m.pos[0], m.pos[1], m.pos[2]); d.scale.setScalar(m.radius);
      d.visible = frame >= m.frame;
      d.material.opacity = Math.min(0.78, 0.2 + 0.58 * Math.min(1, (frame - m.frame) / (S.fps * 0.6)));
    }
    for (const [id, d] of F.scorch) if (!S.scorch.some((m) => m.id === id)) { d.visible = false; }
    // People: hit reactions, then the wounds on their wardrobe.
    this._sfxUndoPeople();
    for (const [pid, hits] of Object.entries(S.hits)) {
      const who = this._sfxPersonOf(pid), g = who && this.actorMeshes.get(pid);
      if (!g || frame < hits[0].frame) continue;
      if (who.physics?.baked) continue;   // the physics has them (knocked down by a blast)
      this._sfxReact(who, g, hits, frame, S.fps);
    }
    const W = X.woundsAt(S.rigs, S.fires, frame, { fps: S.fps });
    const live = new Set();
    for (const w of W) {
      const who = this._sfxPersonOf(w.target), g = who && this.actorMeshes.get(w.target);
      if (!g) continue;
      live.add(w.id);
      let d = F.wounds.get(w.id);
      if (!d || d.parent !== g) {
        if (d) d.parent?.remove(d);
        d = new THREE.Group(); d.userData.glass = true; d.userData.sfxWound = true;
        const mat = new THREE.MeshStandardMaterial({ color: BLOOD, roughness: 0.45, metalness: 0, polygonOffset: true, polygonOffsetFactor: -3, side: THREE.DoubleSide });
        mat.allowOverride = false;   // the stain shows in the Clay guide too, so LTX sees where it is
        const stain = new THREE.Mesh(w.kind === "slash" ? new THREE.PlaneGeometry(0.2, 0.014) : new THREE.CircleGeometry(1, 18), mat);
        const trickle = new THREE.Mesh(new THREE.PlaneGeometry(0.018, 1), mat);
        trickle.geometry.translate(0, -0.5, 0);
        stain.userData.glass = trickle.userData.glass = true;
        d.add(stain, trickle); d.userData.stain = stain; d.userData.trickle = trickle;
        if (w.kind === "slash") stain.rotation.z = 0.35;
        g.add(d); F.wounds.set(w.id, d);
      }
      const H = (who.height_m || LIBRARY[who.kind]?.height || 1.8);
      const L0 = X.bodyPointLocal(w.point, H), n = new THREE.Vector3(...L0.normal);
      // In the group's own frame (it carries the actor's scale): the point just off the clothes, facing out.
      const sc = who.scale || 1;
      d.position.set(L0.pos[0] / sc * sc, L0.pos[1] / sc * sc, L0.pos[2] / sc * sc).addScaledVector(n, 0.012);
      d.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
      const r = (w.kind === "slash" ? 1 : 0.035 + 0.06 * w.stain) * Math.sqrt(w.power);
      d.userData.stain.scale.setScalar(w.kind === "slash" ? Math.min(1, w.age / 0.12) : r);
      d.userData.trickle.scale.set(1, Math.max(0.001, w.trickle), 1);
      d.userData.trickle.position.y = -0.01;
      d.userData.trickle.visible = w.trickle > 0.002;
      d.visible = true;
    }
    for (const [id, d] of F.wounds) if (!live.has(id)) d.visible = false;
  };

  /** Put the limbs this module bent last frame back (if nothing else posed them since), so scrubbing back is exact. */
  P._sfxUndoPeople = function () {
    for (const g of this._sfxPosed || []) {
      for (const s of g.userData.sfxSaved || []) {
        const r = s.pivot.rotation;
        if (Math.abs(r.x - s.wrote[0]) < 1e-9 && Math.abs(r.y - s.wrote[1]) < 1e-9 && Math.abs(r.z - s.wrote[2]) < 1e-9) r.set(s.orig[0], s.orig[1], s.orig[2]);
      }
      g.userData.sfxSaved = null;
      // The body itself: back to where the stage put it (only if nothing moved it since), so the next reaction starts
      // from the authored pose and never adds onto the last frame's lean, roll or shift.
      const b = g.userData.sfxBody;
      if (b && g.position.toArray().every((v, i) => Math.abs(v - b.wrote[0][i]) < 1e-9) && g.quaternion.toArray().every((v, i) => Math.abs(v - b.wrote[1][i]) < 1e-9)) {
        g.position.fromArray(b.orig[0]); g.quaternion.fromArray(b.orig[1]);
      }
      g.userData.sfxBody = null;
    }
    this._sfxPosed = [];
  };

  /** The hit reaction on a person's group: the snap and stagger, the lean and twist, the hand to the wound, the fall. */
  P._sfxReact = function (who, g, hits, frame, fps) {
    const z = X.personReactionAt(hits, frame, { fps });
    const first = hits[0], H = (who.height_m || LIBRARY[who.kind]?.height || 1.8);
    const L0 = X.bodyPointLocal(first.point, H);
    const hv = new THREE.Vector3(L0.normal[0], 0, L0.normal[2]);
    if (hv.lengthSq() < 1e-6) hv.set(0, 0, 1);
    hv.normalize();
    const away = hv.clone().negate();
    // Lean away from the hit (a chest or back hit), or fold over it (a stomach hit, a stab); the fall goes the same way.
    const dir = (first.R.lean >= 0 ? away : hv).clone();
    const fallTilt = z.fall === "knee" ? 0.35 : z.fall ? Math.PI / 2 * 0.96 : 0;
    const ang = Math.abs(z.lean) * (1 - z.down) + fallTilt * z.down;
    const axis = new THREE.Vector3(dir.z, 0, -dir.x).normalize();   // up × dir: a positive turn tips the head towards dir
    const qT = new THREE.Quaternion().setFromAxisAngle(axis, Math.abs(ang));
    const qW = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), z.twist);
    const body0 = [g.position.toArray(), g.quaternion.toArray()];
    const base = g.quaternion.clone();
    const shift = away.clone().multiplyScalar(z.back).applyQuaternion(base);
    g.position.add(shift);
    if (z.fall && z.fall !== "knee") g.position.y += 0.12 * z.down;   // lying on the ground, not through it
    g.quaternion.multiply(qW).multiply(qT);
    // Limbs: a hand to the wound, knees giving.
    const saved = [], limbs = g.userData.limbs || [];
    const bend = (l, x, y, zz) => {
      const r = l.pivot.rotation, orig = [r.x, r.y, r.z];
      r.set(x(r.x), y(r.y), zz(r.z));
      saved.push({ pivot: l.pivot, orig, wrote: [r.x, r.y, r.z] });
    };
    const c = z.clutch, hand = z.clutchHand, kneel = z.fall === "knee" ? z.down : 0, crouch = Math.max(kneel, z.drop / 0.25);
    for (const l of limbs) {
      const mine = hand === "both" || (hand === "l" && l.side > 0) || (hand === "r" && l.side < 0);
      // The hand to the wound: the upper arm a little forward and in across the body, the forearm folded up to it.
      if (c > 0 && mine && l.part === "shoulder") bend(l, (v) => v + (-0.4 - v) * c, (v) => v, (v) => v + (-l.side * 0.5 - v) * c);
      if (c > 0 && mine && l.part === "elbow") bend(l, (v) => v + (-1.4 - v) * c, (v) => v, (v) => v);
      if (crouch > 0 && l.part === "hip") bend(l, (v) => v + (-1.0 - v) * Math.min(1, crouch), (v) => v, (v) => v);
      if (crouch > 0 && l.part === "knee") bend(l, (v) => v + (1.7 - v) * Math.min(1, crouch), (v) => v, (v) => v);
    }
    if (kneel > 0) g.position.y -= 0.42 * H / 1.8 * kneel;   // down on the knees (the shins on the ground)
    g.userData.sfxSaved = saved;
    g.userData.sfxBody = { orig: body0, wrote: [g.position.toArray(), g.quaternion.toArray()] };
    this._sfxPosed.push(g);
  };

  // Camera shake from the explosions (on unless scene.physics.sfxShake === false).
  const cam0 = P._shotCameraAt;
  P._shotCameraAt = function (frame) {
    const cam = cam0.call(this, frame);
    if (this.state.physics?.sfxShake === false) return cam;
    const S = this._sfxState();
    if (!S?.fires.some((f) => f.kind === "explosion")) return cam;
    const k = X.sfxShakeAt(S.rigs, S.fires, Math.round(frame), cam.position, { fps: S.fps, posOf: S.posOf });
    return { ...cam, position: cam.position.map((v, i) => v + k.pos[i]), target: cam.target.map((v, i) => v + k.aim[i]) };
  };

  // Markers never in a capture, the depth pass or the ID matte (a breakaway pane is a real prop: it stays in Clay and Color).
  const render0 = P._renderMode;
  P._renderMode = function (mode, forCapture = false) {
    const marks = [];
    for (const a of this._sfxRigs?.() || []) {
      const m = this.actorMeshes.get(a.id)?.userData.sfxMarker;
      if (!m) continue;
      m.traverse((o) => { if (o.isMesh) { marks.push([o, o.visible]); if (o.userData.sfxMarker) o.visible = o.visible && !forCapture && mode !== "id" && mode !== "depth"; else if (o.userData.sfxPane) o.visible = o.visible && mode !== "id" && mode !== "depth"; } });
    }
    const vis = this._sfxFx?.group.visible;
    if (this._sfxFx && (mode === "id" || mode === "depth")) this._sfxFx.group.visible = false;
    try { return render0.call(this, mode, forCapture); } finally {
      for (const [o, v] of marks) o.visible = v;
      if (this._sfxFx) this._sfxFx.group.visible = vis;
    }
  };
}
