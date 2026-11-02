// Physics panel additions (Milestone 28): soft-body types for the selected cloth / rope / cardboard / grains object,
// and the scene's ground type for the particle system (desert sand, concrete dust, wet spray, wood splinters).
// installSoftPanel(PhysicsPanel) extends the panel's _build and sync; the rigid-body rows hide for a soft body.

const CSS = `
.ss-stage .ss-phys .ph-soft { display:flex; flex-direction:column; gap:6px; border-top:1px solid var(--cv-edge, rgba(255,255,255,.1)); padding-top:6px; }
.ss-stage .ss-phys .ph-soft[hidden] { display:none !important; }
.ss-stage .ss-phys .ph-soft .ph-st { font-weight:650; }
.ss-stage .ss-phys .ph-soft .ss-views { flex-wrap:wrap; row-gap:2px; }
.ss-stage .ss-phys .ph-soft .ss-views button { flex:1 1 auto; white-space:nowrap; padding-left:4px !important; padding-right:4px !important; }`;

const TYPE_LABEL = { cloth: "Cloth", rope: "Rope", cardboard: "Cardboard", grains: "Grains" };
const PINS = { cloth: [["top_corners", "Corners"], ["top_edge", "Top edge"], ["left_edge", "Pole edge"], ["none", "Loose"]],
  rope: [["ends", "Both ends"], ["end", "One end"], ["none", "Loose"]] };

const el = (tag, cls, ...kids) => { const e = document.createElement(tag); if (cls) e.className = cls; for (const k of kids.flat()) if (k != null) e.append(k); return e; };
const stop = (e) => e.addEventListener("pointerdown", (ev) => ev.stopPropagation());

export function installSoftPanel(PhysicsPanel) {
  const P = PhysicsPanel.prototype, build0 = P._build, sync0 = P.sync;
  P._build = function () {
    build0.call(this);
    if (!document.getElementById("ss-softphys-css")) document.head.append(Object.assign(document.createElement("style"), { id: "ss-softphys-css", textContent: CSS }));
    const sec = el("div", "ph-soft");
    sec.hidden = true;
    this.softTitle = el("div", "ph-st", "Soft body");
    this.softKinds = el("div", "ss-views");
    const row = (label, min, max, step, fmt, key, tip) => {
      const input = Object.assign(document.createElement("input"), { type: "range", min, max, step });
      const out = document.createElement("output");
      const r = el("label", "ph-row", el("span", "", label), input, out);
      r.title = tip; stop(input);
      input.addEventListener("input", () => { out.textContent = fmt(+input.value); });
      input.addEventListener("change", () => this._softSet({ [key]: +input.value }));
      return { r, input, out, fmt, key };
    };
    this.softRows = {
      wind: row("Wind", 0, 20, 0.5, (v) => `${v} m/s`, "wind", "Wind speed: gusts travel downwind across the cloth"),
      gust: row("Gusts", 0, 1.5, 0.05, (v) => `${Math.round(v * 100)}%`, "gust", "How much the wind gusts above and below its speed"),
      stiff: row("Stiffness", 0.3, 1, 0.01, (v) => v.toFixed(2), "stiff", "How much it resists stretching"),
      yield: row("Yield", 0.02, 0.2, 0.005, (v) => `${(v * 100).toFixed(1)}%`, "yield", "Cardboard: the bend it takes before it creases and stays bent (lower crushes sooner)"),
      friction: row("Friction", 0.2, 1.5, 0.05, (v) => v.toFixed(2), "friction", "Grains: how steep the pile can stand before it slumps"),
    };
    this.pinSel = document.createElement("select"); stop(this.pinSel);
    this.pinSel.addEventListener("change", () => this._softSet({ pins: this.pinSel.value }));
    this.pinRow = el("label", "ph-mat", el("span", "", "Pins"), this.pinSel);
    this.pinRow.title = "Which particles are tied in place (they ride the object's own keys, or the object it is attached to)";
    this.attSel = document.createElement("select"); stop(this.attSel);
    this.attSel.addEventListener("change", () => this._softSet({ attach: this.attSel.value || null }));
    this.attRow = el("label", "ph-mat", el("span", "", "Attach to"), this.attSel);
    this.attRow.title = "The pins ride this object's motion: a cape on a rider, a flag on a moving car";
    this.softNote = el("div", "ph-note");
    sec.append(this.softTitle, this.softKinds, ...Object.values(this.softRows).map((r) => r.r), this.pinRow, this.attRow, this.softNote);
    this.softSec = sec;
    // Ground type (the whole scene): what hits, hooves and tyres throw up.
    this.groundSel = document.createElement("select"); stop(this.groundSel);
    this.groundSel.addEventListener("change", () => { const r = this.stage.setGroundType?.(this.groundSel.value); if (r) this._msg(`Ground: ${this.groundSel.selectedOptions[0].textContent} (dust, debris and spray off every hit, hoof and tyre).`); this.sync(); });
    this.groundRow = el("label", "ph-mat", el("span", "", "Ground"), this.groundSel);
    this.groundRow.title = "The ground's dust and debris for every hit, hoof and tyre: desert sand, concrete dust, wet spray or wood splinters (Auto follows the set and weather)";
    this.el.insertBefore(sec, this.note);
    this.el.insertBefore(this.groundRow, this.note);
  };
  P._softSet = function (patch) {
    if (!this.id) return;
    const r = this.stage.setSoft?.(this.id, patch);
    if (r) this._msg(`${r.name || r.kind}: changed; Simulate & bake to see it move.`);
    this.sync();
  };
  P.sync = function () {
    sync0.call(this);
    const g = this.stage.groundTypeInfo?.();
    if (g && this.groundSel) {
      if (this.groundSel.options.length !== Object.keys(g.choices).length) { this.groundSel.textContent = ""; for (const [k, v] of Object.entries(g.choices)) this.groundSel.append(new Option(v, k)); }
      this.groundSel.value = g.setting;
    }
    const info = this.id ? this.stage.softInfo?.(this.id) : null;
    if (!this.softSec) return;
    this.softSec.hidden = !info;
    for (const r of [this.seg, this.mass.r, this.bounce.r, this.friction.r, this.lift.r, this.matRow]) r.hidden = !!info;
    if (!info) return;
    this.all.hidden = true;
    this.softTitle.textContent = `Soft body · ${TYPE_LABEL[info.type]}`;
    this.softKinds.textContent = "";
    for (const [k, label] of info.kinds) {
      const b = el("button", "", label); b.type = "button"; stop(b);
      b.setAttribute("aria-pressed", String(k === info.kind));
      b.addEventListener("click", () => this._softSet({ kind: k }));
      this.softKinds.append(b);
    }
    this.softKinds.hidden = info.kinds.length < 2;
    const show = { wind: info.type === "cloth", gust: info.type === "cloth", stiff: info.type === "cloth", yield: info.type === "cardboard", friction: info.type === "grains" };
    for (const [k, r] of Object.entries(this.softRows)) {
      r.r.hidden = !show[k];
      const v = info.spec[k] ?? (k === "gust" ? 0.6 : 0);
      r.input.value = v; r.out.textContent = r.fmt(+v);
    }
    const pins = PINS[info.type];
    this.pinRow.hidden = !pins || info.spec.shape === "bridge";
    if (pins) { this.pinSel.textContent = ""; for (const [k, l] of pins) this.pinSel.append(new Option(l, k)); this.pinSel.value = info.spec.pins; }
    this.attRow.hidden = !(info.type === "cloth" || info.type === "rope");
    this.attSel.textContent = ""; this.attSel.append(new Option("Nothing (its own keys)", ""));
    for (const [id, nm] of info.hosts) this.attSel.append(new Option(nm, id));
    this.attSel.value = info.attach || "";
    this.softNote.textContent = info.baked
      ? `Baked: ${info.bake.n} particles over ${info.bake.frames} frames in ${(info.bake.ms / 1000).toFixed(1)} s (a vertex cache the guide plays). Simulate again after you move things.`
      : "Not baked yet: Simulate & bake runs it against every prop, person and vehicle on its keys.";
    this.note.textContent = "";
  };
}
