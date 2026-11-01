// Presets (Milestone 17): applying one. Every apply is one undo step (⌘Z or the toast's Undo): the stage edits land
// as a single stage history entry, and the look and the cut it touched come back with it.
//
//   const r = new PresetRunner({ stage, host, catalog, setups });
//   const res = await r.apply("crane_up");          // { ok, said, label, target, undoable }
//   r.undo(); r.redo();
//
// host (all optional; see web/ui/presets.mjs for the App's): look {get(), set(patch), load(json), applyStyle(id)} ·
// cut {load(), save(v), add(ids), panel()} · pipeline · shotsInOrder() · wholeFrame(prompt) · importVideo() ·
// confirm(message) -> Promise<bool> · say(msg).
import { cameraKeys, lightingPlan, gradePatch, crateStack, driveKeys, throwKeys, editStyleCut, userCameraKeys,
  VEHICLE_KINDS, PERSON_KINDS, RIDE_KINDS, LOW_PROPS } from "./engine.mjs";
import { imperfectStack, idSeed } from "../stage/impacts.mjs";

const clone = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));
const DEG = Math.PI / 180;
/** The support a move gets when its preset doesn't name one. */
const DEFAULT_RIG = { push_in: "dolly", pull_out: "dolly", dolly_zoom: "dolly", whip_pan: "tripod", car_mount: "free" };
const STEP_SAID = {
  video_to_3d: "rebuild the video as a 3D set", new_angle: "add a new angle", ripple_mode: "open Ripple edit",
  whole_frame: "open Whole frame", quality_draft: "set Draft quality", quality_hollywood: "set Hollywood quality",
  render_all_draft: "queue drafts of every shot", render_final: "queue the final",
};

const isPerson = (a) => PERSON_KINDS.has(a?.kind);
const isVehicle = (a) => VEHICLE_KINDS.has(a?.kind);
const nameOf = (a) => a?.name || a?.kind || "it";

export class PresetRunner {
  constructor({ stage, host = {}, catalog, setups = [], onApplied = null } = {}) {
    Object.assign(this, { stage, host, catalog, setups, onApplied });
    this.undoStack = [];
    this.redoStack = [];
    this.user = [];             // user presets (web/ui/presets.mjs loads and saves them)
    this._hookUndo();
  }

  get(id) { return this.catalog?.byId?.get(id) || this.user.find((p) => p.id === id) || null; }
  all() { return [...(this.catalog?.presets || []), ...this.user]; }

  // ----------------------------------------------------------------------------------------- what it acts on
  scene() { return this.stage.toJSON(); }
  shotInfo() {
    const s = this.scene();
    const order = (() => { try { return this.host.shotsInOrder?.() || null; } catch { return null; } })() || s.shots || [];
    const sid = s.active_shot || order[0]?.id;
    const i = order.findIndex((x) => x.id === sid);
    const sh = (s.shots || []).find((x) => x.id === sid) || {};
    return { id: sid, n: i >= 0 ? i + 1 : 1, name: sh.name || sid, shot: sh, label: `shot ${i >= 0 ? i + 1 : 1}` };
  }
  selected() {
    const id = this.stage.selected;
    return id ? (this.scene().actors || []).find((a) => a.id === id) || null : null;
  }
  _actors() { return this.scene().actors || []; }
  _vehicle() {
    const sel = this.selected();
    if (isVehicle(sel)) return sel;
    if (sel?.mount_id) { const h = this._actors().find((a) => a.id === sel.mount_id); if (isVehicle(h)) return h; }
    return this._actors().find((a) => isVehicle(a) && !/boat|ski|sail|catamaran/.test(a.kind)) || this._actors().find(isVehicle) || null;
  }
  _person({ free = false } = {}) {
    const sel = this.selected();
    if (isPerson(sel)) return sel;
    const ppl = this._actors().filter(isPerson);
    return (free ? ppl.find((a) => !a.mount_id) : null) || ppl.find((a) => !a.mount_id) || ppl[0] || null;
  }
  _last() { try { return this.stage._lastFrame(); } catch { return Math.max(1, (this.scene().shot?.frames || 97) - 1); } }
  _fps() { return this.scene().shot?.fps || 24; }
  _pos(a, frame = 0) {
    try { const p = this.stage._actorPosAt?.(this.stage.state.actors.find((x) => x.id === a.id), frame); if (p) return [...p]; } catch { /* fake stage */ }
    return [...(a.keys?.[0]?.position || a.position || [0, 0, 0])];
  }
  _heading(a) {
    try { const h = this.stage._headingAt?.(this.stage.state.actors.find((x) => x.id === a.id), 0); if (Number.isFinite(h)) return h / DEG; } catch { /* fake */ }
    const k = a.keys || [];
    if (k.length > 1) { const p0 = k[0].position, p1 = k[k.length - 1].position; if (Math.hypot(p1[0] - p0[0], p1[2] - p0[2]) > 0.5) return Math.atan2(p1[0] - p0[0], p1[2] - p0[2]) / DEG; }
    return +a.rotation_deg || 0;
  }

  // ----------------------------------------------------------------------------------------- undo
  _snap() {
    let look = null, cut = null;
    try { look = clone(this.host.look?.get?.()); } catch { /* no look */ }
    try { cut = clone(this.host.cut?.load?.()); } catch { /* no cut */ }
    return { scene: this.stage.toJSON(), look, cut };
  }

  _restoreExtras(s) {
    try { if (s.look && this.host.look?.load) this.host.look.load(clone(s.look)); } catch { /* look panel away */ }
    try { if (s.cut && this.host.cut?.save) this.host.cut.save(clone(s.cut)); } catch { /* cut away */ }
  }

  /** ⌘Z on the stage reverts a preset's look and cut too, when the step it undoes is the preset's. */
  _hookUndo() {
    const st = this.stage;
    if (!st || st.__presetHooked || typeof st.undo !== "function") return;
    st.__presetHooked = true;
    const u0 = st.undo.bind(st), r0 = st.redo?.bind(st);
    st.undo = (...a) => {
      const top = st._hist?.[st._hist.length - 1];
      const ok = u0(...a);
      const e = this.undoStack[this.undoStack.length - 1];
      if (ok && e && e.afterSig && e.afterSig === top) { this.undoStack.pop(); this._restoreExtras(e.before); this.redoStack.push(e); }
      return ok;
    };
    if (r0) st.redo = (...a) => {
      const e = this.redoStack[this.redoStack.length - 1];
      const ok = r0(...a);
      const top = st._hist?.[st._hist.length - 1];
      if (ok && e && e.afterSig === top) { this.redoStack.pop(); this._restoreExtras(e.after); this.undoStack.push(e); }
      return ok;
    };
  }

  get canUndo() { return this.undoStack.length > 0; }

  /** Undo the last preset (the toast's Undo): one step, wherever the stage history stands. */
  undo() {
    const e = this.undoStack[this.undoStack.length - 1];
    if (!e) return null;
    const st = this.stage;
    if (st._hist && st._hist[st._hist.length - 1] === e.afterSig && st._hist.length > 1) { st.undo(); return e.label; }
    // Something else changed since: put the scene back as it was before the preset, as a new step.
    this.undoStack.pop();
    this._loadState(e.before.scene, true);
    this._restoreExtras(e.before);
    this.redoStack.push(e);
    return e.label;
  }

  redo() {
    const e = this.redoStack[this.redoStack.length - 1];
    if (!e) return null;
    const st = this.stage;
    if (st._redo?.length && st._redo[st._redo.length - 1] === e.afterSig) { st.redo(); return e.label; }
    this.redoStack.pop();
    this._loadState(e.after.scene, true);
    this._restoreExtras(e.after);
    this.undoStack.push(e);
    return e.label;
  }

  /** Swap the whole stage state (crates added, keys baked...) without leaving the playhead or the selection. */
  _loadState(s, record = false) {
    const st = this.stage, frame = st.frame || 0, sel = st.selected;
    st.load(clone(s));
    try { st.setFrame(Math.min(frame, Math.max(0, (s.shot?.frames || 97) - 1))); } catch { /* fake */ }
    if (sel && (s.actors || []).some((a) => a.id === sel)) try { st.select(sel); } catch { /* fake */ }
    try { st.onShots?.(); } catch { /* */ }
    if (record) { st.onChange(st.toJSON()); }
  }

  // ----------------------------------------------------------------------------------------- apply
  /**
   * Apply preset `id` to the current shot (or the selected object). opts.confirmGpu: true (already confirmed, e.g.
   * by the Director), false (never queue), or omitted (ask with host.confirm). source: "panel" | "director" | ...
   */
  async apply(id, opts = {}) {
    const p = this.get(id);
    if (!p) return { ok: false, said: `There's no preset called '${id}'.` };
    const a = p.apply || {};
    if (a.recipe) return this._recipe(p, opts);
    const before = this._snap();
    const st = this.stage;
    const target = this.shotInfo();
    let res;
    st._muteRecord = true;
    try {
      res = await this._run(p, opts);
    } catch (e) {
      res = { ok: false, said: `${p.label} didn't work: ${e.message || e}` };
    } finally {
      st._muteRecord = false;
    }
    if (!res.ok) {
      // Nothing half-done is left behind.
      if (JSON.stringify(st.toJSON()) !== JSON.stringify(before.scene)) { st._muteRecord = true; try { this._loadState(before.scene, true); } finally { st._muteRecord = false; } }
      this._restoreExtras(before);
      return { ...res, label: p.label, id: p.id };
    }
    // The preset is written on the scene (what's on this shot), which also makes it its own history step.
    const s = st.state || null;
    if (s) {
      s.preset_log = [...(s.preset_log || []).slice(-9), { id: p.id, tab: p.tab, shot: target.id, t: Math.round(Date.now() / 1000) }];
      st._muteRecord = true;
      try { st.onChange(st.toJSON()); } finally { st._muteRecord = false; }
    }
    try { st._record?.(); } catch { /* fake stage */ }
    const entry = { id: p.id, label: p.label, before, after: this._snap(), afterSig: st._hist?.[st._hist.length - 1] };
    this.undoStack.push(entry);
    if (this.undoStack.length > 40) this.undoStack.shift();
    this.redoStack = [];
    const where = res.where || (p.tab === "action" || p.tab === "edit" ? res.whereObj || target.label : target.label);
    const out = { ok: true, id: p.id, label: p.label, tab: p.tab, target: where, said: res.said || `Applied '${p.label}' to ${where}.`,
      undoable: true, note: res.note || null, source: opts.source || "panel" };
    try { this.onApplied?.(out); } catch { /* listener */ }
    return out;
  }

  async _run(p, opts) {
    const a = p.apply || {};
    if (a.camera) return this._camera(p);
    if (a.light) return this._light(p);
    if (a.look) return this._look(p);
    if (a.stunt) return this._stunt(p);
    if (a.shake) return this._shake(p);
    if (a.physics) return this._physics(p);
    if (a.mount) return this._mount(p);
    if (a.edit) return this._edit(p, opts);
    if (a.user_camera || a.user_light || a.user_look) return this._user(p);
    return { ok: false, said: `${p.label} has nothing to apply.` };
  }

  _camera(p) {
    const st = this.stage, a = p.apply;
    const info = this.shotInfo();
    let sh = info.shot;
    const keys = sh.camera_keys || this.scene().camera_keys || [];
    // A move after a person-follow (handheld) goes back to world space first; a car mount keeps riding the car.
    const followed = sh.camera_follow ? this._actors().find((x) => x.id === sh.camera_follow) : null;
    if (followed && isPerson(followed) && a.camera.move !== "follow") { st.setCameraFollow(null); sh = this.shotInfo().shot; }
    const k0 = (sh.camera_keys || keys)[0];
    const plan = cameraKeys(k0, a.camera, this._last());
    if (!plan) return { ok: false, said: `${p.label}: this shot has no camera to move yet.` };
    let note = null;
    if (plan.follow === "vehicle") {
      const v = this._vehicle();
      if (!v) return { ok: false, said: "Car mount needs a car on set: add one (type “sports car” in Add) and try again." };
      st.setCameraFollow(v.id, plan.carView);
      note = `on the ${nameOf(v).toLowerCase()}`;
    } else if (plan.follow === "person") {
      const who = this._person();
      if (!who) return { ok: false, said: "Handheld follow needs a person on set to follow." };
      st.setCameraFollow(who.id);
      st.setCameraKeys(plan.keys);
      note = `following ${nameOf(who)}`;
    } else {
      st.setCameraKeys(plan.keys);
    }
    const rig = a.rig || DEFAULT_RIG[a.camera.move];
    if (rig && typeof st.setRig === "function") st.setRig(rig);
    return { ok: true, said: `Applied '${p.label}' to ${info.label}${note ? ` (${note})` : ""}: ${plan.keys.length || 1} editable camera key${(plan.keys.length || 1) === 1 ? "" : "s"}${rig && rig !== "free" ? ` on a ${rig}` : ""}.` };
  }

  _light(p) {
    const st = this.stage;
    const plan = lightingPlan(p.apply.light, this.setups);
    if (plan.time) st.applyTimePreset(plan.time);
    if (plan.setup) st.applyLightingSetup(plan.setup);
    if (plan.weather) st.setEnvironment?.({ weather: plan.weather });
    if (st.state?.lighting) { st.state.lighting.setup_prompt = plan.words; st.state.lighting.preset_words = plan.words; }
    const look = this.host.look;
    if (look?.get && look?.set && Object.keys(plan.grade).length) look.set(gradePatch(look.get().grade || {}, plan.grade));
    const info = this.shotInfo();
    let note = null;
    // Imported footage: the stage light can't change pixels that were shot, so Whole frame relights the frame instead.
    if (info.shot?.source || this.scene().reference?.source) {
      try { this.host.wholeFrame?.(`relight this exact frame, same people and framing: ${plan.words}`); note = "footage: Whole frame is ready to relight it"; } catch { /* no paint studio */ }
    }
    const n = plan.setup?.lights?.length || 0;
    return { ok: true, note, said: `Applied '${p.label}' to the set: ${plan.time ? `${plan.time.replace(/_/g, " ")}, ` : ""}${n ? `${n} light${n === 1 ? "" : "s"} (${plan.setup.label})` : "the sky"}${Object.keys(plan.grade).length ? ", and the grade" : ""}.${note ? " The shot is imported footage: Paint Studio's Whole frame has the relight words ready (it runs on the GPU when you press it)." : ""}`, where: "the set" };
  }

  _look(p) {
    const look = this.host.look;
    if (!look) return { ok: false, said: "Looks need the Look panel." };
    if (look.applyStyle && look.hasStyle?.(p.id) !== false) look.applyStyle(p.id);
    else {
      const a = p.apply;
      const patch = { style: p.id };
      if (a.grade) patch.grade = { ...(look.get().grade || {}), ...a.grade };
      look.set(patch);
    }
    return { ok: true, said: `Applied the '${p.label}' look to the frames.`, where: "the look" };
  }

  _stunt(p) {
    const v = this._vehicle();
    if (!v) return { ok: false, said: `${p.label} needs a car on set: add one (type “sports car” in Add) and try again.` };
    const got = this.stage.applyStunt(v.id, p.apply.stunt);
    if (!got) return { ok: false, said: `The ${nameOf(v).toLowerCase()} can't do a ${p.label}.` };
    return { ok: true, said: `Applied '${p.label}' to the ${nameOf(v).toLowerCase()}: its keys now drive the stunt (drag them to change it).`, whereObj: `the ${nameOf(v).toLowerCase()}` };
  }

  /** Camera shake on impact for this shot: jolts keyed off the baked hits (simulate first if nothing is baked). */
  _shake(p) {
    const st = this.stage, kind = p.apply.shake;
    if (!st.setImpactShake) return { ok: false, said: "This stage can't shake the camera." };
    const r = st.setImpactShake(kind);
    if (!r) return { ok: false, said: `Unknown shake '${kind}'.` };
    const hits = r.hits;
    return { ok: true, said: kind === "off" ? "Impact shake off for this shot."
      : `Impact shake (${kind}) on this shot: the camera jolts a beat after ${hits ? `each of the ${hits} baked hits` : "each hit, once something is simulated"} and settles.` };
  }

  _physics(p) {
    const st = this.stage, kind = p.apply.physics, last = this._last();
    const s = this.scene();
    const stamp = Date.now().toString(36);
    let msg = "", where = "the set";
    if (kind === "crate_crash") {
      const v = this._vehicle();
      if (!v) return { ok: false, said: "Crate crash needs a car on set: add one and try again." };
      if (v.stunt) st.applyStunt(v.id, "none");
      const s2 = this.scene();
      const car = s2.actors.find((x) => x.id === v.id);
      const start = this._pos(car, 0), deg = this._heading(car);
      const dir = [Math.sin(deg * DEG), 0, Math.cos(deg * DEG)];
      car.keys = driveKeys(start, deg, 26, last);
      delete car.position_end;
      const at = [start[0] + dir[0] * 12, 0, start[2] + dir[2] * 12];
      const ids = [];
      // Imperfect by default (Milestone 21): crates of slightly different sizes, a little off their marks and turned
      // a few degrees, each sitting on the tallest crate under it, so the pile isn't a perfect video-game grid.
      const pts = crateStack(at, deg, p.apply.count || 6);
      const rough = p.apply.imperfect === false ? null : imperfectStack(pts, 0.8, idSeed(stamp) % 997 + 1);
      pts.forEach((pos0, i) => {
        const id = `crate_${stamp}_${i}`;
        const j = rough?.[i];
        const pos = j ? j.position : pos0;
        ids.push(id);
        s2.actors.push({ id, name: `Crate ${i + 1}`, kind: "crate", position: pos, keys: [{ frame: 0, position: pos }], height_m: j ? j.height_m : 0.8,
          rotation_deg: Math.round((deg + (j ? j.rotation_deg : 0)) * 10) / 10, physics: { mode: "dynamic" } });
      });
      this._loadState(s2);
      st.setPhysics?.(ids, { mode: "dynamic" });
      const r = st.simulatePhysics?.() || { ok: true, message: "" };
      msg = `${ids.length} crates in the ${nameOf(v).toLowerCase()}'s path; it drives straight through. ${r.message || ""}`.trim();
      where = `the ${nameOf(v).toLowerCase()}`;
      return { ok: r.ok !== false, said: `Applied 'Crate crash': ${msg}`, whereObj: where };
    }
    if (kind === "drop" || kind === "throw") {
      const sel = this.selected();
      let prop = sel && !isPerson(sel) && !isVehicle(sel) && !RIDE_KINDS.has(sel.kind) ? sel : null;
      const who = kind === "throw" ? this._person({ free: true }) : null;
      if (kind === "throw" && !who) return { ok: false, said: "Throw needs a person on set to throw it." };
      const s2 = this.scene();
      if (!prop) {
        const near = who || this._person() || null;
        const base = near ? this._pos(near, 0) : [0, 0, 0];
        const id = `crate_${stamp}`;
        prop = { id, name: kind === "throw" ? "Thrown crate" : "Dropped crate", kind: "crate", position: [base[0] + 1.2, 0, base[2]], keys: [{ frame: 0, position: [base[0] + 1.2, 0, base[2]] }], height_m: kind === "throw" ? 0.4 : 0.8, rotation_deg: 0 };
        s2.actors.push(prop);
      }
      const it = s2.actors.find((x) => x.id === prop.id);
      if (kind === "drop") {
        const p0 = this._pos(it, 0);
        it.keys = [{ frame: 0, position: [p0[0], +(p.apply.height || 2.5).toFixed(2), p0[2]] }];
        it.position = [...it.keys[0].position];
        msg = `${nameOf(it)} lifted ${p.apply.height || 2.5} m and let go`;
      } else {
        const wp = this._pos(s2.actors.find((x) => x.id === who.id) || who, 12), deg = +(who.rotation_deg || 0);
        const hand = [wp[0] + Math.sin(deg * DEG) * 0.35, 1.35, wp[2] + Math.cos(deg * DEG) * 0.35];
        const k = throwKeys(hand, deg, 6);
        it.keys = [{ frame: 0, position: hand }, { frame: 12, position: hand }, { frame: 18, position: k[1].position }];
        it.position = [...hand];
        msg = `${nameOf(who)} throws ${nameOf(it).toLowerCase()} half a second in`;
      }
      it.physics = { ...(it.physics || {}), mode: "dynamic", baked: false };
      delete it.physics.source;
      this._loadState(s2);
      st.setPhysics?.([it.id], { mode: "dynamic" });
      const r = st.simulatePhysics?.() || { ok: true, message: "" };
      return { ok: r.ok !== false, said: `Applied '${p.label}': ${msg}. ${r.message || ""}`.trim(), whereObj: nameOf(it) };
    }
    return { ok: false, said: `Unknown physics preset ${kind}.` };
  }

  _mount(p) {
    const st = this.stage, at = Math.round((p.apply.at_seconds ?? 1) * this._fps());
    const rider = this._person({ free: true });
    if (!rider) return { ok: false, said: "Climb / mount needs a person on set." };
    const others = this._actors().filter((x) => x.id !== rider.id && x.id !== rider.mount_id);
    const host = others.find((x) => x.kind === "horse") || others.find((x) => RIDE_KINDS.has(x.kind))
      || others.find((x) => isVehicle(x) && !/boat|sail|catamaran|ski/.test(x.kind)) || others.find((x) => LOW_PROPS.has(x.kind));
    if (!host) return { ok: false, said: "Climb / mount needs a horse, a car or a crate on set to get onto." };
    if (LOW_PROPS.has(host.kind)) {
      const s2 = this.scene();
      const r = s2.actors.find((x) => x.id === rider.id), hp = this._pos(host, 0);
      const k0 = this._pos(r, 0);
      delete r.mount_id; delete r.pose;
      r.keys = [{ frame: 0, position: [k0[0], k0[1] || 0, k0[2]] }, { frame: at, position: [hp[0], +((host.height_m || 0.8) * (host.scale || 1)).toFixed(2), hp[2]] }];
      this._loadState(s2);
      st.onChange(st.toJSON());
      return { ok: true, said: `Applied 'Climb / mount': ${nameOf(rider)} climbs onto ${nameOf(host).toLowerCase()} at ${(at / this._fps()).toFixed(1)} s.`, whereObj: nameOf(rider) };
    }
    const vehicle = isVehicle(host) && !RIDE_KINDS.has(host.kind);
    const taken = this._actors().some((x) => x.mount_id === host.id && (x.seat ?? 0) === 0);
    const ok = st.mount(rider.id, host.id, null, at, vehicle ? (taken ? 1 : 0) : null);
    if (!ok) return { ok: false, said: `${nameOf(rider)} can't get onto ${nameOf(host).toLowerCase()}.` };
    return { ok: true, said: `Applied 'Climb / mount': ${nameOf(rider)} ${vehicle ? "gets into" : "mounts"} the ${nameOf(host).toLowerCase()} at ${(at / this._fps()).toFixed(1)} s.`, whereObj: nameOf(rider) };
  }

  async _edit(p, opts) {
    const cutHost = this.host.cut;
    if (!cutHost?.load || !cutHost?.save) return { ok: false, said: "Edit styles need the Cut." };
    const e = p.apply.edit;
    const panel = (() => { try { return cutHost.panel?.() || null; } catch { return null; } })();
    const notes = [];
    let saved = cutHost.load() || {};
    if (!(saved.cut || []).length) {
      const ids = (this.host.shotsInOrder?.() || this.scene().shots || []).map((s) => s.id);
      if (ids.length && cutHost.add) { cutHost.add(ids); saved = cutHost.load() || {}; }
    }
    // Milestone 19's Cut actions where this build has them (assemble from the lining, beats, subtitles).
    const act = async (name, args = {}) => {
      if (!panel) return false;
      try { const { runCutAction } = await import("../cut/cut.mjs"); await runCutAction(panel, name, args); return true; } catch { return false; }
    };
    if (e.assemble) {
      if (await act("cut.assemble")) { saved = cutHost.load() || saved; notes.push("assembled from the lined script"); }
      else notes.push("kept the current order (assembling from the lined script needs ScriptSync coverage)");
    }
    if (!(saved.cut || []).length) return { ok: false, said: "There's nothing in the cut yet: add shots to the strip first." };
    const next = editStyleCut(saved, e, { fps: this._fps(), styleId: p.id });
    cutHost.save(next);
    try { panel?.refresh?.(); } catch { /* panel hidden */ }
    if (e.beats) { if (await act("cut.cuts_to_beat", { tol: 6 })) notes.push("cuts snapped to the music's beat"); }
    if (e.subtitles) { if (await act("cut.subtitles")) notes.push("subtitles from the dialogue"); }
    if (panel && e.loudness !== undefined) { try { panel.loudTarget = e.loudness; } catch { /* old panel */ } }
    const hasTrans = !!panel && typeof panel.setTransition === "function";
    const trans = (next.cut || []).filter((x) => x.trans).length;
    if (trans && !hasTrans) notes.push("transitions are saved and show once the Cut's transitions (Milestone 19) are in this build");
    const pace = e.pacing_s ? `${e.pacing_s} s clips` : "full clips";
    return { ok: true, said: `Applied '${p.label}' to the cut: ${next.cut.length} clips, ${pace}${trans ? `, ${trans} transition${trans === 1 ? "" : "s"}` : ""}${e.aspect === "9:16" ? ", 9:16" : ""}${notes.length ? `; ${notes.join("; ")}` : ""}.`, whereObj: "the cut", note: notes.join("; ") || null };
  }

  _user(p) {
    const st = this.stage, a = p.apply;
    if (a.user_camera) {
      const sh = this.shotInfo().shot;
      const k0 = (sh.camera_keys || [])[0];
      if (!k0) return { ok: false, said: "This shot has no camera yet." };
      st.setCameraKeys(userCameraKeys(k0, a.user_camera));
      if (a.user_camera.rig && st.setRig) st.setRig(a.user_camera.rig);
      return { ok: true, said: `Applied your '${p.label}' camera to ${this.shotInfo().label}.` };
    }
    if (a.user_light) {
      const s2 = this.scene();
      s2.lighting = clone(a.user_light.lighting);
      if (a.user_light.sun) s2.sun = clone(a.user_light.sun);
      this._loadState(s2);
      st.onChange(st.toJSON());
      return { ok: true, said: `Applied your '${p.label}' lighting to the set.`, where: "the set" };
    }
    if (a.user_look) {
      if (!this.host.look?.load) return { ok: false, said: "Looks need the Look panel." };
      this.host.look.load(clone(a.user_look));
      return { ok: true, said: `Applied your '${p.label}' look.`, where: "the look" };
    }
    return { ok: false, said: "Nothing in that preset." };
  }

  // ----------------------------------------------------------------------------------------- recipes
  /** Multi-step one-clicks. GPU steps ask first (opts.confirmGpu: true = already confirmed, false = never). */
  async _recipe(p, opts = {}) {
    const steps = p.apply.recipe || [];
    const host = this.host, pipe = host.pipeline, st = this.stage;
    const done = [];
    if (p.apply.gpu) {
      let ok = opts.confirmGpu;
      if (ok == null) {
        const shots = steps.includes("render_all_draft") ? (host.shotsInOrder?.() || this.scene().shots || []).length : 1;
        const msg = steps.includes("render_all_draft")
          ? `Draft all shots queues ${shots} draft render${shots === 1 ? "" : "s"} on the GPU (about 2-4 min each). Go ahead?`
          : `Hollywood final renders ${this.shotInfo().label} at the highest quality on the GPU (slow: several minutes). Go ahead?`;
        ok = host.confirm ? await host.confirm(msg) : false;
      }
      if (!ok) return { ok: false, cancelled: true, label: p.label, id: p.id, said: `${p.label}: nothing queued (the GPU wasn't confirmed).` };
    }
    let undoEntry = null;
    for (const s of steps) {
      if (s === "video_to_3d") {
        const sc = this.scene();
        if (sc.reference?.source || sc.reference?.samples?.length) { done.push("the set is already built from your video"); continue; }
        try { host.importVideo?.(); } catch { /* no importer */ }
        return { ok: true, paused: true, label: p.label, id: p.id,
          said: "Video → 3D: pick your clip and the set rebuilds from it (SAM 3D). When it's built, run this recipe again for the new angle." };
      }
      if (s === "new_angle") {
        const before = this._snap();
        st._muteRecord = true;
        try {
          st.addShot("wide");
          const sh = this.shotInfo().shot;
          const plan = cameraKeys(sh.camera_keys[0], { move: "orbit", degrees: 45 }, this._last());
          if (plan) st.setCameraKeys(plan.keys);
          st.setRig?.("dolly");
        } finally { st._muteRecord = false; }
        try { st._record?.(); } catch { /* fake */ }
        undoEntry = { id: p.id, label: p.label, before, after: this._snap(), afterSig: st._hist?.[st._hist.length - 1] };
        done.push(`added a new angle (${this.shotInfo().label}, a 45° orbit on a dolly)`);
      } else if (s === "ripple_mode") {
        try { pipe?.go?.("motion"); pipe?.ripple?.setMode?.("ripple"); done.push("opened Motion › Follow › Ripple edit"); } catch { done.push("Ripple edit isn't in this build"); }
      } else if (s === "whole_frame") {
        try { host.wholeFrame?.(p.apply.prompt || ""); done.push("Whole frame has the wardrobe prompt: finish the sentence, press Whole frame, Keep, then Save to reference"); } catch { /* */ }
      } else if (s === "quality_draft" || s === "quality_hollywood") {
        const q = s === "quality_draft" ? "Draft" : "Hollywood";
        if (pipe?.ltx?.setPreset) { pipe.ltx.setPreset(q); done.push(`${q} quality`); } else done.push(`${q} quality (the quality presets aren't in this build; used the default)`);
      } else if (s === "render_all_draft" || s === "render_final") {
        if (!pipe?._render) { done.push("renders need the ⑤ Motion step"); continue; }
        const ids = s === "render_all_draft" ? (host.shotsInOrder?.() || this.scene().shots || []).map((x) => x.id) : [this.shotInfo().id];
        const prev = this.scene().active_shot;
        let n = 0;
        for (const sid of ids) { try { pipe.selectShot?.(sid); await pipe._render(s === "render_all_draft" ? 3 : 4, false); n++; } catch { /* one failed */ } }
        if (prev && ids.length > 1) try { pipe.selectShot?.(prev); } catch { /* */ }
        done.push(`queued ${n} ${s === "render_all_draft" ? "draft" : "final"}${n === 1 ? "" : "s"}`);
      }
    }
    if (undoEntry) { this.undoStack.push(undoEntry); this.redoStack = []; }
    const out = { ok: true, id: p.id, label: p.label, tab: "recipe", target: this.shotInfo().label, undoable: !!undoEntry, source: opts.source || "panel",
      said: `${p.label}: ${done.join(" · ") || steps.map((x) => STEP_SAID[x]).join(" · ")}.` };
    try { this.onApplied?.(out); } catch { /* */ }
    return out;
  }
}

/** One runner per stage, so the Director's 'preset' tool finds the panel's. */
export const RUNNERS = new WeakMap();

/**
 * The Director's `preset` executor (web/agent/director.mjs EXEC.preset; `this` is the Director). The plan comes from
 * soundstage/presets_agent.py; a GPU recipe only gets here once the Director's own confirm has said yes.
 */
export async function presetExecutor(a, call) {
  const r = RUNNERS.get(this.stage);
  if (!r) return { ok: false, said: "The Presets window isn't loaded." };
  if (a.shot && a.shot !== this.stage.toJSON().active_shot) {
    try { if (this.host?.pipeline?.selectShot) this.host.pipeline.selectShot(a.shot); else this.stage.setActiveShot(a.shot); } catch { this.stage.setActiveShot?.(a.shot); }
  }
  const res = await r.apply(a.preset, { source: "director", confirmGpu: !!call?.gpu });
  return { ok: res.ok, said: res.said };
}

/** Give the Director its preset tool (idempotent). exec = the Director's EXEC table. */
export function installDirectorTool(exec) {
  if (!exec || exec.preset) return false;
  exec.preset = presetExecutor;
  return true;
}
