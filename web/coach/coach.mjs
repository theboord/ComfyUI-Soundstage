// Soundstage Coach: friendly advice while you work. Watches the stage, the cut and the App and shows at most two
// small cards in the stage's corner: what looks wrong, why, and a one-click fix. It never blocks anything.
//
//   import { Coach } from "./coach/coach.mjs";
//   const coach = new Coach(stageViewEl, { stage, app, api, getCut: () => cutProject, onAction: (kind, payload) => … });
//   coach.notify("tab", "look");       // tell it about tab switches (stage changes, shots and Run are picked up itself)
//
// onAction(kind, payload) handles what only the widget can do; return true when handled:
//   "reorder_cut" {order: [shotIds]}   "trim_shot" {shot_id, out}   "open_tab" {tab}   "describe" {}
//   "set_step" {step}                  "set_freedom" {value}        (the last two fall back to the graph widgets)
// Scene fixes ("ops") are applied by the Coach itself through applyOps (stage.load + stage.onChange), so they land
// in the stage's own undo history.
// Rules live in rules.mjs; preferences in localStorage (ss.coach.*), always behind try/catch.

import { TOKENS } from "../ui/theme.mjs";
import { icon } from "../ui/icons.mjs";
import { applyOps } from "../agent/agent.mjs";
import { advise, sceneHash, TOUR } from "./rules.mjs";

const MAX_CARDS = 2;
const COACHES = new Set();
const KEY = { enabled: "ss.coach.enabled", muted: "ss.coach.muted", tour: "ss.coach.tour" };

function store(storage) {
  return {
    get(k, d) { try { const v = storage?.getItem(k); return v === null || v === undefined ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { storage?.setItem(k, JSON.stringify(v)); } catch { /* private mode, blocked storage */ } },
  };
}

/** Decides which advice to show; no DOM. Exposed for tests. */
export class CoachEngine {
  constructor(storage) {
    this.s = store(storage);
    this.enabled = this.s.get(KEY.enabled, true);
    this.muted = new Set(this.s.get(KEY.muted, []));
    this.tourStep = this.s.get(KEY.tour, 0);
    this.snoozed = new Map(); // key -> scene hash it was snoozed at
  }

  setEnabled(on) { this.enabled = !!on; this.s.set(KEY.enabled, this.enabled); }
  mute(rule) { this.muted.add(rule); this.s.set(KEY.muted, [...this.muted]); }
  unmuteAll() { this.muted.clear(); this.s.set(KEY.muted, []); }
  snooze(key, hash) { this.snoozed.set(key, hash); }
  tourNext() { this.tourStep += 1; this.s.set(KEY.tour, this.tourStep); }
  tourDone() { this.tourStep = TOUR.length; this.s.set(KEY.tour, this.tourStep); }

  /** Advice to show for an event, after mutes and snoozes, at most MAX_CARDS. */
  pick(event, ctx) {
    if (!this.enabled) return [];
    const items = advise(event, { ...ctx, tourStep: this.tourStep });
    // "Not now" holds until the scene changes ("run" advice holds until the next run).
    for (const [k, h] of this.snoozed) if (h !== ctx.sceneHash && !k.startsWith("tour")) this.snoozed.delete(k);
    return items.filter((x) => !this.muted.has(x.rule) && !this.snoozed.has(x.key)).slice(0, MAX_CARDS);
  }
}

let cssDone = false;
function injectCss(doc) {
  if (cssDone || !doc?.head) return;
  cssDone = true;
  const T = TOKENS;
  const st = doc.createElement("style");
  st.textContent = `
.ss-coach { position:absolute; top:10px; right:10px; z-index:20; display:flex; flex-direction:column; align-items:flex-end;
  gap:8px; max-width:min(340px, calc(100% - 20px)); pointer-events:none; font:13px/1.4 "Soundstage Grotesk", ui-sans-serif, system-ui, sans-serif; }
.ss-coach > * { pointer-events:auto; }
.ss-coach-toggle { display:inline-flex; align-items:center; gap:6px; border-radius:999px; padding:4px 10px; cursor:pointer;
  background:${T.raised}; color:${T.muted}; border:1px solid ${T.line}; font:inherit; font-size:12px; }
.ss-coach-toggle[aria-pressed=true] { color:${T.text}; border-color:${T.lineStrong}; }
.ss-coach-toggle[aria-pressed=true] .ss-icon { color:${T.accent}; }
.ss-coach-toggle[data-count]:not([data-count="0"]) { color:${T.text}; border-color:${T.accent}; }
.ss-coach-toggle[data-level=error] { border-color:${T.danger}; }
.ss-coach-cards { max-height:calc(100% - 46px); overflow:auto; }
.ss-coach-off { align-self:flex-end; background:none; border:none; color:${T.faint}; font:inherit; font-size:12px; cursor:pointer; text-decoration:underline; }
.ss-coach-card { width:100%; box-sizing:border-box; background:rgba(33,25,39,.94); backdrop-filter:blur(8px); color:${T.text};
  border:1px solid ${T.line}; border-left:3px solid ${T.lineStrong}; border-radius:12px; padding:10px 12px 10px 12px;
  box-shadow:0 8px 24px rgba(0,0,0,.35); animation:ss-coach-in .18s ease-out; }
.ss-coach-card[data-level=error] { border-left-color:${T.danger}; }
.ss-coach-card[data-level=warn] { border-left-color:${T.accent}; }
.ss-coach-card[data-level=tour] { border-left-color:#8fb3ff; }
.ss-coach-head { display:flex; align-items:flex-start; gap:8px; }
.ss-coach-title { font-weight:600; flex:1; }
.ss-coach-text { color:${T.muted}; margin:4px 0 8px 24px; }
.ss-coach-x { background:none; border:none; color:${T.faint}; cursor:pointer; padding:0; line-height:0; }
.ss-coach-x:hover { color:${T.text}; }
.ss-coach-actions { display:flex; flex-wrap:wrap; gap:6px; margin-left:24px; align-items:center; }
.ss-coach-actions button { border-radius:999px; padding:4px 11px; font:inherit; font-size:12px; cursor:pointer;
  background:${T.raised}; color:${T.text}; border:1px solid ${T.line}; }
.ss-coach-actions button.ss-coach-primary { background:${T.accent}; color:${T.accentInk}; border-color:${T.accent}; font-weight:600; }
.ss-coach-actions button.ss-coach-never { background:none; border:none; color:${T.faint}; padding:4px 2px; text-decoration:underline; }
.ss-coach-actions button:focus-visible, .ss-coach-x:focus-visible, .ss-coach-toggle:focus-visible { outline:2px solid ${T.accent}; outline-offset:2px; }
@keyframes ss-coach-in { from { opacity:0; transform:translateY(-4px); } to { opacity:1; transform:none; } }
@media (prefers-reduced-motion: reduce) { .ss-coach-card { animation:none; } }`;
  doc.head.append(st);
}

/** Find a node's widget in the ComfyUI graph by node type and widget name. */
function widgetOf(app, type, name) {
  const nodes = app?.graph?._nodes || app?.graph?.nodes || [];
  for (const n of nodes) {
    if (n.type !== type) continue;
    const w = n.widgets?.find((x) => x.name === name);
    if (w) return { node: n, w };
  }
  return null;
}

export class Coach {
  /**
   * @param {HTMLElement} container  the stage view (cards float in its top-right corner)
   * @param {{stage, app?, api?, getCut?: () => object, onAction?: (kind, payload) => boolean|void,
   *          storage?: Storage, doc?: Document, pollMs?: number}} opts
   */
  constructor(container, { stage, app = null, api = null, getCut = null, onAction = null, storage = globalThis.localStorage,
    doc = globalThis.document, pollMs = 1200 } = {}) {
    Object.assign(this, { stage, app, api, getCut, onAction, doc });
    this.engine = new CoachEngine(storage);
    this.finalHash = null;
    this.editedSinceRun = false;
    this._last = { hash: null, shots: null };
    this._timer = null;
    injectCss(doc);
    if (container && doc?.defaultView?.getComputedStyle(container).position === "static") container.style.position = "relative";
    this.root = doc.createElement("div");
    this.root.className = "ss-coach";
    this.root.setAttribute("role", "status");
    this.root.setAttribute("aria-live", "polite");
    this.toggle = doc.createElement("button");
    this.toggle.type = "button";
    this.toggle.className = "ss-coach-toggle";
    this.toggle.title = "Coach: tips and checks as you work";
    this.toggle.append(icon("lightbulb", 14), doc.createTextNode("Coach"));
    this.toggle.addEventListener("pointerdown", (e) => e.stopPropagation());
    // Tips never pop up over the stage on their own: they collect behind the pill ("Coach · 2") and open on click.
    this.open = false;
    this._items = [];
    this.toggle.addEventListener("click", () => {
      if (!this.engine.enabled) { this.open = true; this.setEnabled(true); return; }
      this.open = !this.open;
      this._syncToggle();
    });
    this.cards = doc.createElement("div");
    this.cards.className = "ss-coach-cards";
    this.cards.style.cssText = "display:flex;flex-direction:column;gap:8px;width:100%";
    this.root.append(this.toggle, this.cards);
    container?.append(this.root);
    this._syncToggle();

    COACHES.add(this);
    this._hookRun();
    this._onExecuted = (ev) => this._executed(ev?.detail);
    api?.addEventListener?.("executed", this._onExecuted);
    this._poll = setInterval(() => this._tick(), pollMs);
    this._openTimer = setTimeout(() => this.check("open"), 1200);
  }

  // ------------------------------------------------------------------ context
  context() {
    const scene = this.stage.toJSON();
    const hash = sceneHash(scene);
    const step = Number(widgetOf(this.app, "SoundstageStep", "step")?.w.value ?? 1);
    const freedom = Number(widgetOf(this.app, "SoundstageQuality", "motion_freedom")?.w.value ?? 0);
    const lookW = widgetOf(this.app, "SoundstageLook", "look");
    let lookPicked = null, lookDescription = "", lookDescCast = "";
    if (lookW) {
      try {
        const l = typeof lookW.w.value === "string" && lookW.w.value.trim() ? JSON.parse(lookW.w.value) : {};
        lookPicked = Object.keys(l).some((k) => k !== "version" && l[k] && l[k] !== "auto");
        lookDescription = l.description || "";
        lookDescCast = l.description_cast || "";
      } catch { lookPicked = true; }
    }
    let cut = null;
    try { cut = this.getCut?.() || null; } catch { cut = null; }
    const aspect = this.stage.fw && this.stage.fh ? this.stage.fw / this.stage.fh : 960 / 512;
    return { scene, cut, aspect, step, motionFreedom: freedom, lookPicked, lookDescription, lookDescCast, sceneHash: hash, finalHash: this.finalHash,
      editedSinceRun: this.editedSinceRun };
  }

  // ------------------------------------------------------------------ events
  /** Run the rules for an event ("stage" | "shots" | "tab" | "open" | "run") and show the result. */
  check(event = "stage") {
    if (!this.engine.enabled) return this.render([]);
    let ctx;
    try { ctx = this.context(); } catch { return []; }
    const items = this.engine.pick(event, ctx);
    // Keep cards that are still true and not replaced, so advice doesn't flicker on every small edit.
    this.render(items, ctx);
    return items;
  }

  notify(event, _detail) {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.check(event), event === "tab" ? 150 : 600);
  }

  _tick() {
    if (!this.engine.enabled || this.doc?.hidden) return;
    let scene;
    try { scene = this.stage.toJSON(); } catch { return; }
    const hash = sceneHash(scene);
    const shots = JSON.stringify([(scene.shots || []).map((s) => s.id), scene.active_shot]);
    if (this._last.hash === null) { this._last = { hash, shots }; return; }
    if (hash === this._last.hash && shots === this._last.shots) return;
    const shotsChanged = shots !== this._last.shots;
    this._last = { hash, shots };
    this.editedSinceRun = true;
    this.notify(shotsChanged ? "shots" : "stage");
  }

  _hookRun() {
    const app = this.app;
    if (!app?.queuePrompt || app.queuePrompt.__ssCoach) return;
    const orig = app.queuePrompt.bind(app);
    const wrapped = (...args) => {
      for (const c of COACHES) { try { c.check("run"); } catch { /* never block a run */ } }
      for (const c of COACHES) c.editedSinceRun = false;
      return orig(...args);
    };
    wrapped.__ssCoach = true;
    app.queuePrompt = wrapped;
  }

  _executed(detail) {
    const node = detail && this.app?.graph?.getNodeById?.(Number(detail.node));
    if (node && /^Rung 4/.test(node.title || "")) {
      try { this.finalHash = sceneHash(this.stage.toJSON()); } catch { /* ignore */ }
    }
  }

  // ------------------------------------------------------------------ actions
  async act(item, action) {
    const { kind, payload } = action;
    let handled = false;
    try {
      if (kind === "ops") { applyOps(this.stage, payload); handled = true; }
      else if (kind === "tour_next") { this.engine.tourNext(); handled = true; }
      else if (kind === "tour_done") { this.engine.tourDone(); handled = true; }
      else handled = !!(await this.onAction?.(kind, payload));
      if (!handled && kind === "set_step") handled = this._setWidget("SoundstageStep", "step", payload.step);
      if (!handled && kind === "set_freedom") handled = this._setWidget("SoundstageQuality", "motion_freedom", payload.value);
    } catch (e) {
      console.warn("Soundstage Coach: action failed", kind, e);
    }
    if (!handled) this.engine.snooze(item.key, this.context().sceneHash);
    this.check(item.rule === "tour" ? "open" : "stage");
    return handled;
  }

  _setWidget(type, name, value) {
    const hit = widgetOf(this.app, type, name);
    if (!hit) return false;
    hit.w.value = value;
    hit.w.callback?.(value);
    this.app.graph?.setDirtyCanvas?.(true, true);
    return true;
  }

  setEnabled(on) {
    this.engine.setEnabled(on);
    this._syncToggle();
    if (on) this.check("open"); else this.render([]);
  }

  _syncToggle() {
    const n = this.engine.enabled ? this._items.length : 0;
    this.toggle.setAttribute("aria-pressed", String(this.engine.enabled));
    this.toggle.setAttribute("aria-expanded", String(this.open && n > 0));
    this.toggle.dataset.count = String(n);
    this.toggle.dataset.level = this._items.some((i) => i.level === "error") ? "error" : "";
    this.toggle.lastChild.textContent = !this.engine.enabled ? "Coach off" : n ? `Coach · ${n}` : "Coach";
    this.toggle.title = !this.engine.enabled ? "Coach is off: click to turn tips back on"
      : n ? (this.open ? "Hide tips" : `${n} tip${n > 1 ? "s" : ""}: click to show`) : "Coach: tips and checks as you work";
    this.cards.hidden = !(this.open && n > 0);
  }

  // ------------------------------------------------------------------ render
  render(items, ctx) {
    const d = this.doc;
    this._items = items || [];
    if (!this._items.length) this.open = false;
    this.cards.replaceChildren(...this._items.map((item) => {
      const card = d.createElement("div");
      card.className = "ss-coach-card";
      card.dataset.level = item.level;
      card.dataset.rule = item.rule;
      card.addEventListener("pointerdown", (e) => e.stopPropagation());
      card.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });
      const head = d.createElement("div");
      head.className = "ss-coach-head";
      const title = d.createElement("div");
      title.className = "ss-coach-title";
      title.textContent = item.title;
      const x = d.createElement("button");
      x.type = "button";
      x.className = "ss-coach-x";
      x.setAttribute("aria-label", "Not now");
      x.title = "Not now";
      x.append(icon("x", 14));
      x.addEventListener("click", () => this._dismiss(item, ctx));
      head.append(icon(item.icon || "lightbulb", 16), title, x);
      const text = d.createElement("div");
      text.className = "ss-coach-text";
      text.textContent = item.text;
      const row = d.createElement("div");
      row.className = "ss-coach-actions";
      for (const a of item.actions || []) {
        const b = d.createElement("button");
        b.type = "button";
        b.textContent = a.label;
        if (a.primary) b.className = "ss-coach-primary";
        b.addEventListener("click", () => this.act(item, a));
        row.append(b);
      }
      if (item.rule !== "tour") {
        const later = d.createElement("button");
        later.type = "button";
        later.textContent = "Not now";
        later.addEventListener("click", () => this._dismiss(item, ctx));
        const never = d.createElement("button");
        never.type = "button";
        never.className = "ss-coach-never";
        never.textContent = "Don't show again";
        never.addEventListener("click", () => { this.engine.mute(item.rule); this.check("stage"); });
        row.append(later, never);
      }
      card.append(head, text, row);
      return card;
    }));
    if (this._items.length) {
      const off = d.createElement("button");
      off.type = "button";
      off.className = "ss-coach-off";
      off.textContent = "Turn tips off";
      off.addEventListener("click", () => { this.open = false; this.setEnabled(false); });
      this.cards.append(off);
    }
    this._syncToggle();
  }

  _dismiss(item, ctx) {
    if (item.rule === "tour") this.engine.tourDone();
    else this.engine.snooze(item.key, (ctx || this.context()).sceneHash);
    this.render(this._items.length > 1 ? this.engine.pick("stage", this.context()) : []);
  }

  dispose() {
    clearInterval(this._poll);
    clearTimeout(this._timer);
    clearTimeout(this._openTimer);
    this.api?.removeEventListener?.("executed", this._onExecuted);
    COACHES.delete(this);
    this.root.remove();
  }
}
