// Physics panel additions: the practical-effects (SFX) section (sfx.mjs, sfxstage.mjs). installSfxPanel(PhysicsPanel)
// extends the panel's _build and sync:
//  - Add an SFX rig (explosion, fire, sparks, squib, smoke bomb, breakaway glass, flare, body squib, stunt-knife gag);
//  - for a selected rig: armed, its cue (time, contact, chain, manual), power, reach, colour, surface, the person and the
//    wardrobe point; a big Fire button (K) that records the cue at the playhead; Reset to before; A/B;
//  - for an object an effect touched: Reset to before (puts it, and everything that effect touched, back).
import * as X from "./sfx.mjs";

const CSS = `
.ss-stage .ss-phys .ph-sfx { display:flex; flex-direction:column; gap:6px; border-top:1px solid var(--cv-edge, rgba(255,255,255,.1)); padding-top:6px; }
.ss-stage .ss-phys .ph-sfx[hidden], .ss-stage .ss-phys .ph-sfx [hidden] { display:none !important; }
.ss-stage .ss-phys .ph-sfx .ph-st { font-weight:650; }
.ss-stage .ss-phys .ph-sfx .ph-mat input[type=number] { width:100%; min-width:0; }
.ss-stage .ss-phys .ph-sfx .sfx-fire { font-weight:700; font-size:14px !important; min-height:34px; background:#b5301c !important; color:#fff !important; border-color:#e0522a !important; }
.ss-stage .ss-phys .ph-sfx .sfx-fire:active { transform:scale(.98); }
.ss-stage .ss-phys .ph-sfx .ph-note { font-size:11px; }`;

const TRIG = [["time", "At a time"], ["contact", "On contact"], ["chain", "After another cue"], ["manual", "Manual (Fire / K)"]];
const el = (tag, cls, ...kids) => { const e = document.createElement(tag); if (cls) e.className = cls; for (const k of kids.flat()) if (k != null) e.append(k); return e; };
const stop = (e) => { e.addEventListener("pointerdown", (ev) => ev.stopPropagation()); e.addEventListener("keydown", (ev) => ev.stopPropagation()); return e; };
const button = (label, title, cls = "ss-btn") => { const b = stop(el("button", cls, label)); b.type = "button"; b.title = title; return b; };
const select = (opts) => { const s = stop(document.createElement("select")); for (const [v, l] of opts) s.append(new Option(l, v)); return s; };
const fill = (s, opts, v) => { s.textContent = ""; for (const [k, l] of opts) s.append(new Option(l, k)); s.value = v ?? ""; };

export function installSfxPanel(PhysicsPanel) {
  const P = PhysicsPanel.prototype, build0 = P._build, sync0 = P.sync, show0 = P.show;
  P._build = function () {
    build0.call(this);
    if (!document.getElementById("ss-sfx-css")) document.head.append(Object.assign(document.createElement("style"), { id: "ss-sfx-css", textContent: CSS }));
    const sec = el("div", "ph-sfx");
    const title = el("div", "ph-st", "SFX · practical effects");
    title.title = "On-set special effects, the way a film crew rigs them: each fires on a cue (a time, a contact, after another cue, or by hand) and the bake makes the set react.";
    // Add a rig.
    this.sfxKind = select(Object.entries(X.SFX_KINDS).map(([k, v]) => [k, `${v.icon} ${v.label}`]));
    const add = button("Add", "Add this rig in front of the camera (a body squib or knife gag goes on the selected person)");
    add.addEventListener("click", () => {
      const a = this.stage.addSfxRig?.(this.sfxKind.value, { target: this.id });
      if (!a) { this._msg(X.SFX_KINDS[this.sfxKind.value]?.onActor ? "Select a person first: a body squib or knife gag goes on their wardrobe." : "Couldn't add that rig."); return; }
      this.stage.select?.(a.id);
      this._msg(`${a.name} added: cue at ${a.sfx.trigger.at} s. Change the cue, power and reach below; K fires it at the playhead.`);
    });
    const addRow = el("label", "ph-mat", el("span", "", "Add rig"), el("div", "ph-acts", this.sfxKind, add));
    // The selected rig.
    const r = (label, ctl, tip) => { const row = el("label", "ph-mat", el("span", "", label), ctl); row.title = tip; return row; };
    const num = (min, max, step) => stop(Object.assign(document.createElement("input"), { type: "number", min, max, step }));
    this.sfx = {
      armed: button("Armed", "Disarmed rigs don't fire (Reset to before disarms)"),
      trig: select(TRIG), at: num(0, 600, 0.05), watch: select([]), after: select([]), delay: num(0, 30, 0.05),
      power: stop(Object.assign(document.createElement("input"), { type: "range", min: 0.1, max: 4, step: 0.05 })), powerOut: document.createElement("output"),
      radius: stop(Object.assign(document.createElement("input"), { type: "range", min: 0.2, max: 25, step: 0.1 })), radiusOut: document.createElement("output"),
      color: select(Object.keys(X.SMOKE_COLORS).map((c) => [c, c[0].toUpperCase() + c.slice(1)])),
      surface: select(X.SQUIB_SURFACES.map((s) => [s, s === "auto" ? "Auto (wall or ground)" : s[0].toUpperCase() + s.slice(1)])),
      target: select([]), point: select(Object.entries(X.BODY_POINTS).map(([k, v]) => [k, v.label[0].toUpperCase() + v.label.slice(1)])),
      fall: select([["auto", "By the hit"], ["yes", "Falls"], ["no", "Stays up"]]),
    };
    const S = this.sfx;
    const set = (patch) => { if (!this.id) return; this.stage.setSfx?.(this.id, patch); this.sync(); };
    S.armed.addEventListener("click", () => set({ armed: !(S.armed.getAttribute("aria-pressed") === "true") }));
    S.trig.addEventListener("change", () => set({ trigger: { type: S.trig.value } }));
    S.at.addEventListener("change", () => set({ trigger: { at: +S.at.value } }));
    S.watch.addEventListener("change", () => set({ trigger: { watch: S.watch.value || null } }));
    S.after.addEventListener("change", () => set({ trigger: { after: S.after.value || null } }));
    S.delay.addEventListener("change", () => set({ trigger: { delay: +S.delay.value } }));
    S.power.addEventListener("input", () => { S.powerOut.textContent = `${(+S.power.value).toFixed(2)}×`; });
    S.power.addEventListener("change", () => set({ power: +S.power.value }));
    S.radius.addEventListener("input", () => { S.radiusOut.textContent = `${(+S.radius.value).toFixed(1)} m`; });
    S.radius.addEventListener("change", () => set({ radius: +S.radius.value }));
    S.color.addEventListener("change", () => set({ color: S.color.value }));
    S.surface.addEventListener("change", () => set({ surface: S.surface.value }));
    S.target.addEventListener("change", () => set({ target: S.target.value }));
    S.point.addEventListener("change", () => set({ point: S.point.value }));
    S.fall.addEventListener("change", () => set({ fall: S.fall.value === "auto" ? null : S.fall.value === "yes" }));
    const pr = (label, input, out, tip) => { const row = el("label", "ph-row", el("span", "", label), input, out); row.title = tip; return row; };
    this.sfxRows = {
      armed: el("div", "ph-acts", S.armed),
      trig: r("Cue", S.trig, "When it fires: at a time, when something hits (or reaches) it, a set delay after another cue, or by hand (Fire / K, also during Drive-mode REC)"),
      at: r("At (s)", S.at, "The time on the shot it fires"),
      watch: r("Watch", S.watch, "Contact: fire at the first hard hit on this object (or anything reaching the rig)"),
      after: r("After", S.after, "Chain: fire after this cue…"),
      delay: r("Delay (s)", S.delay, "…by this long"),
      power: pr("Power", S.power, S.powerOut, "How big the gag is: the blast's push (a car rocks at 1×, rolls at 1.5-2×), the flames, the blood"),
      radius: pr("Reach", S.radius, S.radiusOut, "How far the blast reaches (nothing past it moves), or the size of the fire / smoke"),
      color: r("Colour", S.color, "The smoke's colour"),
      surface: r("Surface", S.surface, "What the bullet hit lands on: dust and chips off a wall, a dirt kick, glass shards, sparks off a car, a spout of water"),
      target: r("On", S.target, "The person wearing the squib or the knife gag"),
      point: r("Where", S.point, "Where it's rigged on the wardrobe: the reaction follows (a chest hit falls back, an arm flinches, a leg buckles)"),
      fall: r("Fall", S.fall, "The stunt performer's fall: by where the hit lands, always, or never"),
    };
    this.sfxFire = button("💥 Fire (K)", "Fire now: records the cue at the playhead as a key (during playback too). In Drive mode, K during REC records it into the take.", "ss-btn sfx-fire");
    this.sfxFire.addEventListener("click", () => { const r2 = this.stage.sfxFire?.(this.id); if (r2) this._msg(`💥 Fired at ${r2.t.toFixed(2)} s: that's its cue now (Undo takes it back).`); this.sync(); });
    this.sfxReset = button("Reset to before", "Disarm it and put everything it touched back exactly as it was (one Undo step)");
    this.sfxReset.addEventListener("click", () => {
      const r2 = X.isSfxRig(this.stage.state.actors.find((a) => a.id === this.id)) ? this.stage.sfxReset?.([this.id]) : this.stage.sfxResetObject?.(this.id);
      if (r2) this._msg(r2.message);
      this.onBaked?.(r2);
      this.sync();
    });
    this.sfxAB = button("A / B", "Compare the previous run (A) with the new one (B)");
    this.sfxAB.addEventListener("click", () => { const w = this.stage.sfxCompare?.(); this._msg(w ? `Showing ${w === "a" ? "A: the previous run" : "B: the new run"}.` : "Nothing to compare (or edited since: run it again)."); this.onBaked?.(); this.sync(); });
    this.sfxActs = el("div", "ph-acts", this.sfxFire);
    this.sfxActs2 = el("div", "ph-acts", this.sfxReset, this.sfxAB);
    this.sfxNote = el("div", "ph-note");
    this.sfxRig = el("div", "ph-sfx-rig", ...Object.values(this.sfxRows), this.sfxActs, this.sfxActs2);
    this.sfxRig.style.cssText = "display:flex;flex-direction:column;gap:6px";
    sec.append(title, addRow, this.sfxRig, this.sfxNote);
    this.sfxSec = sec;
    this.el.insertBefore(sec, this.note);
  };

  // The panel is for any selection (a rig or not): the SFX section is always there.
  P.show = function (info) { return show0.call(this, info); };

  P.sync = function () {
    sync0.call(this);
    if (!this.sfxSec) return;
    const st = this.stage, a = this.id ? st.state.actors.find((x) => x.id === this.id) : null;
    const info = a && X.isSfxRig(a) ? st.sfxInfo?.(this.id) : null;
    this.sfxRig.hidden = !info;
    // A rig has no rigid-body settings of its own.
    for (const row of [this.seg, this.mass?.r, this.bounce?.r, this.friction?.r, this.lift?.r, this.matRow, this.all]) if (row) row.hidden = row.hidden || !!info;
    if (!info) {
      const rec = st.state.physics?.sfx;
      const touched = rec && a && ((rec.affected || []).some((x) => x.id === a.id) || (rec.burning || {})[a.id] || (rec.wounds || []).some((w) => w.target === a.id));
      this.sfxActs2.hidden = !touched;
      this.sfxNote.textContent = touched ? "An SFX cue touched this: Reset to before puts it (and everything that cue touched) back as it was." : "";
      if (touched) { this.sfxRig.hidden = false; for (const v of Object.values(this.sfxRows)) v.hidden = true; this.sfxActs.hidden = true; this.sfxAB.hidden = true; }
      return;
    }
    for (const v of Object.values(this.sfxRows)) v.hidden = false;
    this.sfxActs.hidden = false; this.sfxActs2.hidden = false; this.sfxAB.hidden = !info.ab;
    const s = info.sfx, S = this.sfx, R = this.sfxRows, kind = s.kind, body = X.SFX_KINDS[kind].onActor;
    this.name.textContent = `SFX · ${info.name}`;
    S.armed.setAttribute("aria-pressed", String(s.armed));
    S.armed.textContent = s.armed ? "Armed" : "Disarmed (click to arm)";
    S.trig.value = s.trigger.type;
    S.at.value = s.trigger.at;
    fill(S.watch, [["", "Anything that reaches it"], ...info.objects], s.trigger.watch || "");
    fill(S.after, [["", "(pick a cue)"], ...info.rigs], s.trigger.after || "");
    S.delay.value = s.trigger.delay;
    S.power.value = s.power; S.powerOut.textContent = `${s.power.toFixed(2)}×`;
    S.radius.value = s.radius; S.radiusOut.textContent = `${s.radius.toFixed(1)} m`;
    S.color.value = s.color; S.surface.value = s.surface;
    fill(S.target, info.people, s.target || "");
    S.point.value = s.point;
    S.fall.value = s.fall === true ? "yes" : s.fall === false ? "no" : "auto";
    R.at.hidden = s.trigger.type !== "time";
    R.watch.hidden = s.trigger.type !== "contact";
    R.after.hidden = R.delay.hidden = s.trigger.type !== "chain";
    R.radius.hidden = !["explosion", "fire", "smoke_bomb", "sparks"].includes(kind);
    R.color.hidden = kind !== "smoke_bomb";
    R.surface.hidden = kind !== "squib";
    R.target.hidden = R.point.hidden = R.fall.hidden = !body;
    if (kind === "stab") R.point.hidden = false;
    const fps = st.state.shot?.fps || 24;
    const fires = info.fires.map((f) => `${(f.frame / fps).toFixed(2)} s${f.by !== "time" ? ` (${f.by.replace(/^contact:|^chain:/, (m) => (m === "contact:" ? "contact with " : "after "))})` : ""}`);
    const did = info.affected.map((x) => `${st.state.actors.find((b) => b.id === x.id)?.name || x.id} ${x.how}`);
    this.sfxNote.textContent = !s.armed ? "Disarmed: it doesn't fire. Arm it to run it again (the bake starts from the untouched scene)."
      : (fires.length ? `Fires at ${fires.join(", ")}.` : s.trigger.type === "manual" ? "No cue yet: play the shot and press Fire (K) at the moment." : "It doesn't fire in this shot (check its cue).")
        + (did.length ? ` The blast: ${did.join(", ")}.` : "") + " Scrub back before the cue: everything is untouched. A practical effect on a film set; fiction only.";
    this.note.textContent = "";
  };
}
