// Physics panel for the selected object: Dynamic / Static / Off, mass, bounce, friction and start height, then
// "Simulate & bake" (the whole scene's dynamic objects, baked into keys) and "Clear simulation". It floats over the
// canvas beside the inspector (canvas layout) and never makes the page scroll.
import { icon } from "../ui/icons.mjs";

const CSS = `
.ss-stage .ss-phys { display:flex; flex-direction:column; gap:8px; font-size:12px; }
.ss-stage .ss-phys[hidden] { display:none !important; }
.ss-stage.ss-cl[data-ws=wide] .ss-clarea > .ss-phys { position:absolute; z-index:21; top:6px; right:calc(var(--ss-insp-w,320px) + 14px);
  width:290px; max-height:calc(100% - 12px); overflow:auto; scrollbar-width:thin; background:var(--cv-glass-strong, rgba(26,20,31,.92));
  border:1px solid var(--cv-edge, rgba(255,255,255,.1)); border-radius:14px; padding:8px 10px 10px; backdrop-filter:blur(10px);
  box-shadow:0 10px 30px rgba(0,0,0,.35); }
.ss-stage .ss-phys .ph-head { display:flex; align-items:center; gap:6px; font-weight:650; font-size:13px; }
.ss-stage .ss-phys .ph-head .nm { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ss-stage .ss-phys .ph-head button { padding:0 8px !important; min-height:0; line-height:22px; }
.ss-stage .ss-phys .ss-views { display:flex; }
.ss-stage .ss-phys .ss-views button { flex:1 1 0; justify-content:center; }
.ss-stage .ss-phys .ph-row { display:grid; grid-template-columns:64px minmax(0,1fr) 54px; gap:6px; align-items:center; color:var(--ss-muted); }
.ss-stage .ss-phys .ph-row input { width:100%; accent-color:var(--ss-accent, #f2ff59); }
.ss-stage .ss-phys .ph-row output { text-align:right; font-variant-numeric:tabular-nums; }
.ss-stage .ss-phys .ph-row[aria-disabled=true] { opacity:.4; pointer-events:none; }
.ss-stage .ss-phys .ph-acts { display:flex; gap:6px; flex-wrap:wrap; }
.ss-stage .ss-phys .ph-acts button { flex:1 1 auto; justify-content:center; }
.ss-stage .ss-phys .ph-note { color:var(--ss-muted); line-height:1.35; }
.ss-stage .ss-phys .ph-msg { color:var(--ss-text); line-height:1.35; min-height:1.35em; }
.ss-stage .ss-phys .ph-all { align-self:flex-start; font-size:11px !important; padding:2px 10px !important; }`;

const MODES = [["dynamic", "Dynamic", "Falls, tumbles and gets knocked over"], ["static", "Static", "Stays put; things hit it and land on it"],
  ["off", "Off", "Ignored by the simulation"]];

// Mass on a log scale: 0.2 kg .. 2 t.
const M_LO = Math.log(0.2), M_HI = Math.log(2000);
const massToT = (m) => (Math.log(Math.max(0.2, Math.min(2000, m))) - M_LO) / (M_HI - M_LO);
const tToMass = (t) => { const m = Math.exp(M_LO + t * (M_HI - M_LO)); return m < 10 ? +m.toFixed(1) : Math.round(m); };
const fmtMass = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} t` : `${m} kg`);

const el = (tag, cls, ...kids) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const k of kids.flat()) if (k != null) e.append(k);
  return e;
};
const btn = (label, cls, title, ic = null) => {
  const b = el("button", cls || "ss-btn");
  b.type = "button";
  if (ic) { b.dataset.ssIcon = ic; b.append(icon(ic, 13)); }
  b.append(label);
  b.title = title || "";
  b.addEventListener("pointerdown", (e) => e.stopPropagation());
  return b;
};

export class PhysicsPanel {
  /** stage: Stage; onStatus(msg); onBaked(): refresh the timeline after a bake or clear. */
  constructor({ stage, onStatus = () => {}, onBaked = () => {} }) {
    this.stage = stage; this.onStatus = onStatus; this.onBaked = onBaked; this.id = null;
    if (!document.getElementById("ss-phys-css")) document.head.append(Object.assign(document.createElement("style"), { id: "ss-phys-css", textContent: CSS }));
    this.el = el("section", "ss-phys");
    this.el.hidden = true;
    this.el.setAttribute("role", "dialog");
    this.el.setAttribute("aria-label", "Physics");
    for (const t of ["pointerdown", "wheel"]) this.el.addEventListener(t, (e) => e.stopPropagation(), { passive: true });
    this.el.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); this.close(); this.btn.focus?.(); } });
    // The button that opens it, for the selected object's card.
    this.btn = btn("Physics", "ss-btn", "Real-world physics for this object: drop, tumble, get knocked over. Simulate, then it's ordinary keys.", "atom");
    this.btn.setAttribute("aria-expanded", "false");
    this.btn.addEventListener("click", () => this.toggle());
    this._build();
  }

  _build() {
    const name = el("span", "nm", "Physics");
    const x = btn("×", "ss-btn", "Close (Esc)");
    x.addEventListener("click", () => this.close());
    this.name = name;
    const head = el("div", "ph-head", icon("atom", 14), name, x);
    this.seg = el("div", "ss-views");
    this.modeBtns = {};
    for (const [m, label, tip] of MODES) {
      const b = btn(label, "", tip);
      b.addEventListener("click", () => this._set({ mode: m }));
      this.modeBtns[m] = b;
      this.seg.append(b);
    }
    const row = (label, min, max, step, fmt, toVal, tip) => {
      const input = Object.assign(document.createElement("input"), { type: "range", min, max, step });
      const out = document.createElement("output");
      const r = el("label", "ph-row", el("span", "", label), input, out);
      r.title = tip;
      input.addEventListener("pointerdown", (e) => e.stopPropagation());
      input.addEventListener("input", () => { out.textContent = fmt(toVal(+input.value)); });
      return { r, input, out, fmt, toVal };
    };
    this.mass = row("Mass", 0, 1, 0.001, fmtMass, tToMass, "How heavy it is: a heavy crate shrugs off a light one, a car sends both flying");
    this.bounce = row("Bounce", 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`, (v) => v, "0 = thud, 100% = superball");
    this.friction = row("Friction", 0, 1.5, 0.05, (v) => v.toFixed(2), (v) => v, "How much it grips: 0.2 ice, 0.6 wood, 1.0 rubber");
    this.lift = row("Height", 0, 5, 0.05, (v) => `${v.toFixed(2)} m`, (v) => v, "Start this far off the floor: drop it, or stack it on another object");
    for (const [k, rr] of Object.entries({ mass: this.mass, bounce: this.bounce, friction: this.friction, lift: this.lift })) {
      rr.input.addEventListener("change", () => this._set({ [k]: rr.toVal(+rr.input.value) }));
    }
    this.all = btn("Same for all", "ss-btn ph-all", "Give every object of this kind the same physics");
    this.all.addEventListener("click", () => {
      const info = this.stage.physicsInfo(this.id);
      if (!info) return;
      const ids = this.stage.physicsKindIds(info.kind);
      const p = { mode: info.mode, mass: info.mass, bounce: info.bounce, friction: info.friction };
      this.stage.setPhysics(ids, p);
      this._msg(`${ids.length} × ${info.kind.replace(/_/g, " ")}: ${info.mode}, ${fmtMass(info.mass)}.`);
      this.sync();
    });
    this.simBtn = btn("Simulate & bake", "ss-btn ss-primary", "Run the physics over the whole shot and bake every Dynamic object into keys (undo with Cmd/Ctrl+Z)", "play");
    this.simBtn.addEventListener("click", () => this.simulate());
    this.clearBtn = btn("Clear simulation", "ss-btn", "Put every simulated object back on the keys it had before the bake", "rotate-ccw");
    this.clearBtn.addEventListener("click", () => {
      const n = this.stage.clearPhysics();
      this._msg(n ? `Cleared ${n} simulated object${n === 1 ? "" : "s"}: back on their own keys.` : "Nothing is simulated yet.");
      this.onBaked();
      this.sync();
    });
    this.note = el("div", "ph-note");
    this.msg = el("div", "ph-msg");
    this.msg.setAttribute("aria-live", "polite");
    this.el.append(head, this.seg, this.mass.r, this.bounce.r, this.friction.r, this.lift.r, this.all, el("div", "ph-acts", this.simBtn, this.clearBtn), this.note, this.msg);
  }

  _msg(t) { this.msg.textContent = t; if (t) this.onStatus(t); }

  _set(patch) {
    if (!this.id) return;
    this.stage.setPhysics(this.id, patch);
    this.sync();
  }

  async simulate() {
    this.simBtn.disabled = true;
    this._msg("Simulating…");
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    try {
      const res = this.stage.simulatePhysics();
      this._msg(res.message);
      this.onBaked(res);
    } catch (err) {
      this._msg(`Simulation failed: ${err.message}`);
    } finally {
      this.simBtn.disabled = false;
      this.sync();
    }
  }

  /** Selection changed (info from stage.selectedInfo, or null). */
  show(info) {
    this.id = info?.id ?? null;
    this.btn.hidden = !info;
    if (!info) { this.close(); return; }
    this.sync();
  }

  sync() {
    const info = this.id ? this.stage.physicsInfo(this.id) : null;
    if (!info) return;
    this.name.textContent = `Physics · ${info.name}`;
    for (const [m, b] of Object.entries(this.modeBtns)) b.setAttribute("aria-pressed", String(info.mode === m));
    this.modeBtns.dynamic.disabled = !info.canMove;
    const set = (rr, v, t) => { rr.input.value = t ?? v; rr.out.textContent = rr.fmt(v); };
    set(this.mass, info.mass, massToT(info.mass));
    set(this.bounce, info.bounce);
    set(this.friction, info.friction);
    set(this.lift, info.lift);
    const on = info.mode !== "off";
    for (const rr of [this.bounce, this.friction]) rr.r.setAttribute("aria-disabled", String(!on));
    this.mass.r.setAttribute("aria-disabled", String(info.mode !== "dynamic"));
    this.lift.r.setAttribute("aria-disabled", String(!on || !info.canMove));
    this.all.hidden = info.kindCount < 2 || !info.canMove;
    this.all.textContent = `Same for all ${info.kindCount} ${info.kind.replace(/_/g, " ")}${/s$/.test(info.kind) ? "" : "s"}`;
    this.clearBtn.disabled = !this.stage.state.actors.some((a) => a.physics?.baked);
    this.note.textContent = !info.canMove
      ? "People, animals and vehicles push props with their keyed motion; they don't fall over themselves."
      : info.baked ? "Baked: it plays as keys now (edit them on the timeline). Simulate again to redo it from its own keys."
        : `${info.dynamicCount} dynamic object${info.dynamicCount === 1 ? "" : "s"} in the scene. Keyed moves play first; physics takes over at the last key, at that speed (a throw).`;
  }

  isOpen() { return !this.el.hidden; }
  open() { this.el.hidden = false; this.btn.setAttribute("aria-expanded", "true"); this.btn.setAttribute("aria-pressed", "true"); this.sync(); }
  close() { this.el.hidden = true; this.btn.setAttribute("aria-expanded", "false"); this.btn.setAttribute("aria-pressed", "false"); }
  toggle() { if (this.isOpen()) this.close(); else this.open(); }
}
