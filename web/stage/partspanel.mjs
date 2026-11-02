// The "Parts" section of Properties (Milestone 26): every keyframeable channel of the selected object, film light or
// the shot camera, grouped (Wheels, Suspension, Doors, Lights, Glass, Paint / Head & neck, Tail, Gait / Face, Eyes,
// Hands / Pivot, Material / Light / Lens), each with its control, its value, and a key button:
//   ◆ a key on the playhead (click: remove it)   ◇ animated, no key here (click: key it)   ○ not animated (click: key it)
//   Shift+click the key: ease → linear → step for the key here. ‹ › jump to its keys, ✕ clears the channel.
// Changing a value that isn't animated sets it for the whole shot; once a channel has keys (or Auto-key is on), a
// change keys the playhead, like Sequencer and Maya. One undo step per change (a slider drag is one step).
// Shortcuts over the viewport with a vehicle selected: L headlights, Shift+L light bar, I indicators, O driver's door
// (Shift+O every door), K key every part at the playhead.
import { optionsOf, specOf } from "./objparts.mjs";
import { withKeys } from "../ui/shortcuts.mjs";
import { icon } from "../ui/icons.mjs";

const CSS = `
.ss-parts { flex:1 1 100%; min-width:0; box-sizing:border-box; display:flex; flex-direction:column; gap:6px; padding:10px 12px; border-radius:12px; background:rgba(255,255,255,.035);
  border:1px solid rgba(255,255,255,.08); font-size:12px; margin-top:6px; }
.ss-parts[hidden] { display:none !important; }
.ss-parts .hd { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.ss-parts .hd strong { font-size:13px; font-weight:650; display:inline-flex; gap:6px; align-items:center; }
.ss-parts .hd .sp { flex:1 1 auto; }
.ss-parts .chip { border-radius:999px; padding:2px 9px; font:inherit; font-size:11px; cursor:pointer; background:rgba(255,255,255,.06);
  color:inherit; border:1px solid rgba(255,255,255,.12); }
.ss-parts .chip:hover { border-color:#f2ff59; }
.ss-parts .chip[aria-pressed="true"] { border-color:#f2ff59; color:#f2ff59; background:rgba(242,255,89,.1); }
.ss-parts details { border-top:1px solid rgba(255,255,255,.06); padding-top:4px; }
.ss-parts summary { cursor:pointer; font-weight:600; font-size:11px; text-transform:uppercase; letter-spacing:.07em; opacity:.75; padding:2px 0; }
.ss-parts .row { display:grid; grid-template-columns:78px minmax(0,1fr) 44px 16px 36px; gap:4px; align-items:center; padding:2px 0; }
.ss-parts .row > select { grid-column:2 / 4; }
.ss-parts .row > span { opacity:.8; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ss-parts .row > span:first-child { white-space:normal; overflow-wrap:anywhere; text-overflow:clip; line-height:1.15; }
.ss-parts .row input[type=range] { width:100%; accent-color:#f2ff59; min-width:0; }
.ss-parts .row select { width:100%; min-width:0; font:inherit; font-size:11px; background:rgba(255,255,255,.06); color:inherit;
  border:1px solid rgba(255,255,255,.14); border-radius:6px; padding:2px 4px; }
.ss-parts .row input[type=number] { width:100%; min-width:0; font:inherit; font-size:11px; background:transparent; color:inherit;
  border:1px solid rgba(255,255,255,.12); border-radius:6px; padding:1px 3px; text-align:right; font-variant-numeric:tabular-nums; }
.ss-parts .key { width:16px; height:18px; display:inline-flex; align-items:center; justify-content:center; border-radius:5px; cursor:pointer;
  background:transparent; border:0; color:rgba(240,239,237,.45); font-size:13px; line-height:1; padding:0; }
.ss-parts .key[data-s="here"] { color:#f2ff59; }
.ss-parts .key[data-s="anim"] { color:#8bd4a8; }
.ss-parts .key:hover { background:rgba(255,255,255,.08); }
.ss-parts .nav { display:flex; gap:0; }
.ss-parts .nav button { width:12px; height:18px; border:0; padding:0; background:transparent; color:rgba(240,239,237,.55); cursor:pointer; font-size:11px; }
.ss-parts .nav button:hover { color:#f2ff59; }
.ss-parts .note { opacity:.62; font-size:11px; }
.ss-stage .ss-parts .row button.key, .ss-stage .ss-parts .nav button { padding:0 !important; min-width:0 !important; min-height:0 !important; box-sizing:border-box; }
.ss-parts .row > span.nav { overflow:visible; }
.ss-parts input[type=number]::-webkit-inner-spin-button, .ss-parts input[type=number]::-webkit-outer-spin-button { -webkit-appearance:none; margin:0; }
.ss-parts input[type=number] { -moz-appearance:textfield; }
.ss-parts .auto { font-size:10px; opacity:.6; margin-left:4px; }`;

const keyCombo = (k) => (k ? k.split("+") : null);
const fmt = (spec, v) => {
  if (v === null || v === undefined || v === "") return "—";
  if (spec.type === "enum") return "";
  const d = spec.step >= 1 ? 0 : spec.step >= 0.1 ? 1 : 2;
  return `${(+v).toFixed(d)}${spec.unit || ""}`;
};

export class PartsPanel {
  /** host: where the section goes; opts: {stage, onStatus, title, fixedId (the camera), people: {posePanel}} */
  constructor(host, { stage, onStatus = () => {}, title = "Parts", fixedId = null, posePanel = null } = {}) {
    this.stage = stage; this.onStatus = onStatus; this.title = title; this.fixedId = fixedId; this.posePanel = posePanel;
    if (!document.getElementById("ss-parts-css")) document.head.append(Object.assign(document.createElement("style"), { id: "ss-parts-css", textContent: CSS }));
    this.el = Object.assign(document.createElement("div"), { className: "ss-parts", hidden: true });
    this.el.dataset.parts = fixedId || "object";
    this.el.addEventListener("pointerdown", (e) => e.stopPropagation());
    this.el.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });
    this.el.addEventListener("keydown", (e) => e.stopPropagation());
    host.append(this.el);
    this.rows = new Map();
    this.open = new Set(["Doors", "Lights", "Lens", "Light", "Face", "Head & neck"]);
    try { this.autoKey = localStorage.getItem("ss_parts_autokey") === "1"; } catch { this.autoKey = false; }
    this._poll = setInterval(() => { if (!this.el.hidden && this.id) this.refresh(); }, 250);
    if (fixedId) this.bind(fixedId, title);
  }

  dispose() { clearInterval(this._poll); this.el.remove(); }

  /** Show the parts of an object id, "light:<id>" or "__camera__" (null hides the section). */
  bind(id, name = "") {
    if (!id) { this.id = null; this.el.hidden = true; return; }
    const chans = this.stage.partChannels(id);
    const sig = `${id}|${chans.map((c) => c.ch).join(",")}`;
    this.id = id; this.name = name;
    this.el.hidden = !chans.length && !this._isPerson();
    // New rows always get their values: refresh() skips when the frame and the parts JSON are unchanged, and two
    // untouched objects have the same parts JSON, so a crate then a car left the car's sliders mid-track (QA round 07).
    if (sig !== this._sig) { this._sig = sig; this._build(chans); this.refresh(true); return; }
    this.refresh();
  }

  _isPerson() {
    const a = this.stage.state.actors.find((x) => x.id === this.id);
    return !!a && ["man", "woman", "child"].includes(a.kind);
  }

  _btn(cls, text, title, fn) {
    const b = Object.assign(document.createElement("button"), { type: "button", className: cls, textContent: text, title });
    b.addEventListener("click", fn);
    return b;
  }

  _build(chans) {
    const el = this.el;
    el.replaceChildren();
    this.rows.clear();
    const hd = document.createElement("div");
    hd.className = "hd";
    const t = document.createElement("strong");
    t.append(icon("sliders-horizontal", 13), this.title);
    const sp = Object.assign(document.createElement("span"), { className: "sp" });
    hd.append(t, sp);
    if (!this.fixedId || this.fixedId === "__camera__") {
      const ak = this._btn("chip", "Auto-key", "Auto-key: every change keys the playhead, even on a channel that isn't animated yet", () => {
        this.autoKey = !this.autoKey;
        ak.setAttribute("aria-pressed", String(this.autoKey));
        try { localStorage.setItem("ss_parts_autokey", this.autoKey ? "1" : "0"); } catch { /* storage blocked */ }
      });
      ak.setAttribute("aria-pressed", String(this.autoKey));
      hd.append(ak);
    }
    if (this.id !== "__camera__") hd.append(this._btn("chip", "Key all", withKeys("Key every part at the playhead", ["K"]), () => this.keyAll()));
    if (!this.fixedId && this.stage.drive?.canDrive(this.id)) hd.append(this._btn("chip", "🎮 Drive", withKeys("Drive it like a video game (keys, mouse or a controller); ● REC records it as keys", ["D"]), () => this.stage.drive.start(this.id)));
    el.append(hd);
    const groups = new Map();
    for (const c of chans) { if (!groups.has(c.spec.group)) groups.set(c.spec.group, []); groups.get(c.spec.group).push(c); }
    for (const [g, list] of groups) {
      const det = document.createElement("details");
      det.open = this.open.has(g) || groups.size <= 2;
      det.addEventListener("toggle", () => { if (det.open) this.open.add(g); else this.open.delete(g); });
      const sum = Object.assign(document.createElement("summary"), { textContent: g });
      det.append(sum);
      for (const c of list) det.append(this._row(c));
      el.append(det);
    }
    if (this._isPerson()) el.append(this._people());
    const note = Object.assign(document.createElement("div"), { className: "note",
      textContent: "◆ key here · ◇ animated · ○ not animated. Click to key, Shift+click: ease / linear / step. Keys also show on the timeline under the object." });
    el.append(note);
  }

  _row(c) {
    const { ch, spec } = c;
    const row = Object.assign(document.createElement("div"), { className: "row" });
    row.dataset.ch = ch;
    const lab = Object.assign(document.createElement("span"), { textContent: spec.label, title: withKeys(spec.tip, keyCombo(spec.key)) });
    let input, num = null;
    const send = (v, sliding = false) => {
      window.__ssSliding = sliding;
      const r = this.stage.setPart(this.id, ch, v, this.autoKey && !spec.static ? { key: true } : {});
      if (r === null) this.onStatus(`${spec.label}: can't use ${v}.`);
      this.refresh(true);
    };
    if (spec.type === "enum") {
      input = document.createElement("select");
      for (const [k, l] of Object.entries(optionsOf(ch) || {})) input.append(new Option(l, k));
      input.addEventListener("change", () => send(input.value));
    } else {
      input = Object.assign(document.createElement("input"), { type: "range", min: spec.min, max: spec.max, step: spec.step });
      input.addEventListener("pointerdown", () => { window.__ssSliding = true; });
      input.addEventListener("input", () => send(+input.value, true));
      input.addEventListener("change", () => { window.__ssSliding = false; });
      num = Object.assign(document.createElement("input"), { type: "number", min: spec.min, max: spec.max, step: spec.step });
      num.addEventListener("change", () => send(+num.value));
    }
    input.title = lab.title;
    const out = num || Object.assign(document.createElement("span"), { className: "auto" });
    const key = this._btn("key", "○", "", (e) => {
      if (e.shiftKey) {
        const cur = this.stage.partChannels(this.id).find((x) => x.ch === ch);
        if (!cur?.here) { this.onStatus("Put the playhead on a key to change how it eases."); return; }
        const next = { ease: "linear", linear: "step", step: "ease" }[cur.interp || "ease"];
        this.stage.setPartInterp(this.id, ch, next);
        this.onStatus(`${spec.label}: the key at frame ${this.stage.frame} is now ${next}.`);
      } else {
        const on = this.stage.keyPartHere(this.id, ch);
        this.onStatus(`${spec.label}: ${on ? "keyed" : "key removed"} at frame ${this.stage.frame}.`);
      }
      this.refresh(true);
    });
    if (spec.static) key.style.visibility = "hidden";
    const nav = Object.assign(document.createElement("span"), { className: "nav" });
    nav.append(this._btn("", "‹", "Previous key", () => { this.stage.gotoPartKey(this.id, ch, -1); this.refresh(true); }),
      this._btn("", "›", "Next key", () => { this.stage.gotoPartKey(this.id, ch, 1); this.refresh(true); }),
      this._btn("", "✕", "Clear this channel's keys (back to its default)", () => { this.stage.clearPart(this.id, ch); this.onStatus(`${spec.label}: cleared.`); this.refresh(true); }));
    row.append(lab, input, ...(num ? [out] : []), key, nav);
    this.rows.set(ch, { row, input, num, out, key, nav, spec });
    return row;
  }

  /** People: expression is a channel; the eyes are gaze keys (gaze.mjs); hands are in Pose Studio; props in hand. */
  _people() {
    const box = document.createElement("details");
    box.open = true;
    box.append(Object.assign(document.createElement("summary"), { textContent: "Eyes, hands, in hand" }));
    const st = this.stage, id = this.id;
    // Eyes are gaze keys (web/stage/gaze.mjs, stage.setGaze): only where the stage has them.
    const TARGET_WORDS = ["ahead", "camera", "left", "right", "up", "down"];
    const eyes = Object.assign(document.createElement("div"), { className: "row" });
    eyes.hidden = typeof st.setGaze !== "function";
    const eyesSel = document.createElement("select");
    eyesSel.title = "Where they look from the playhead on (a gaze key: the head turns there, eased, starting at this frame)";
    const others = st.state.actors.filter((x) => x.id !== id);
    for (const w of TARGET_WORDS) eyesSel.append(new Option({ ahead: "Ahead (steady)", camera: "Into the lens", left: "Off left", right: "Off right", up: "Up", down: "Down" }[w] || w, w));
    for (const o of others) eyesSel.append(new Option(`At ${o.name || o.kind}`, o.id));
    eyesSel.addEventListener("change", () => { st.setGaze(id, st.frame, eyesSel.value); this.onStatus(`Eyes: ${eyesSel.selectedOptions[0].textContent} from frame ${st.frame}.`); });
    const eyesClr = this._btn("chip", "✕", "Remove the gaze key at the playhead", () => { st.setGaze(id, st.frame, null); });
    eyes.append(Object.assign(document.createElement("span"), { textContent: "Eyes", title: eyesSel.title }), eyesSel, document.createElement("span"), document.createElement("span"), eyesClr);
    const hands = Object.assign(document.createElement("div"), { className: "row" });
    const handBtn = this._btn("chip", "Pose the hands…", withKeys("Open Pose Studio at the hands: every finger, keyed at the playhead", ["P"]), () => {
      const pp = this.posePanel?.el;
      if (!pp) return;
      for (const d of pp.querySelectorAll("details")) if (/hand|finger/i.test(d.querySelector("summary")?.textContent || "")) d.open = true;
      pp.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
    hands.append(Object.assign(document.createElement("span"), { textContent: "Hands" }), handBtn);
    const held = Object.assign(document.createElement("div"), { className: "row" });
    const heldSel = document.createElement("select");
    heldSel.title = "A prop in their hands from the playhead on (they lift it over a few frames)";
    heldSel.append(new Option("Nothing", ""));
    for (const pid of st.holdableIds(id)) { const p = st.state.actors.find((x) => x.id === pid); heldSel.append(new Option(p.name || p.kind, p.id)); }
    heldSel.value = st.state.actors.find((x) => x.carry_id === id)?.id || "";
    heldSel.addEventListener("change", () => { const n = st.holdProp(id, heldSel.value || null); this.onStatus(n ? `${n} in hand from frame ${st.frame}.` : "Hands empty."); });
    held.append(Object.assign(document.createElement("span"), { textContent: "In hand", title: heldSel.title }), heldSel);
    box.append(eyes, hands, held);
    return box;
  }

  keyAll() {
    if (!this.id) return 0;
    const n = this.stage.keyAllParts(this.id);
    this.onStatus(n ? `Keyed ${n} parts at frame ${this.stage.frame}.` : "Every part already has a key here.");
    this.refresh(true);
    return n;
  }

  refresh(force = false) {
    if (!this.id) return;
    const st = this.stage;
    const sig = st._partsSig(this.id);
    if (!force && st.frame === this._lf && this._lastJson === sig) return;
    this._lf = st.frame;
    this._lastJson = sig;
    const chans = st.partChannels(this.id);
    if (`${this.id}|${chans.map((c) => c.ch).join(",")}` !== this._sig) { this.bind(this.id, this.name); return; }
    for (const c of chans) {
      const r = this.rows.get(c.ch);
      if (!r) continue;
      const v = c.value;
      if (document.activeElement !== r.input) r.input.value = v ?? (c.spec.type === "enum" ? c.spec.def : c.spec.min);
      if (r.num && document.activeElement !== r.num) r.num.value = v == null ? "" : +(+v).toFixed(3);
      if (!r.num) r.out.textContent = c.auto ? "auto" : "";
      r.key.dataset.s = c.here ? "here" : c.keys.length ? "anim" : "none";
      r.key.textContent = c.here ? "◆" : c.keys.length ? "◇" : "○";
      r.key.title = c.here ? `Key at frame ${st.frame} (${c.interp}): click to remove · Shift+click: ease / linear / step`
        : c.keys.length ? `Animated (${c.keys.length} keys): click to key frame ${st.frame}` : `Not animated: click to key frame ${st.frame}${c.auto ? " (it follows the path until you do)" : ""}`;
      r.nav.style.visibility = c.keys.length ? "visible" : "hidden";
      r.row.title = c.auto ? `${c.spec.label}: automatic (${fmt(c.spec, v)}) until you key it` : "";
    }
  }
}

const NEXT = { headlights: { auto: "low", off: "low", low: "high", high: "off" }, indicator: { off: "left", left: "right", right: "hazard", hazard: "off" } };

/** The Parts keys over the viewport (L, Shift+L, I, O, Shift+O, K) for the selected object. Returns true if handled. */
export function partsKey(stage, e, say = () => {}) {
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  const id = stage.selected;
  if (!id) return false;
  const k = e.key.toLowerCase();
  const chans = stage.partChannels(id).map((c) => c.ch);
  const v = (ch) => stage.partValue(id, ch);
  if (k === "l" && !e.shiftKey && chans.includes("headlights")) { const n = NEXT.headlights[v("headlights")] || "low"; stage.setPart(id, "headlights", n); say(`Headlights: ${optionsOf("headlights")[n]}.`); return true; }
  if (k === "l" && e.shiftKey && chans.includes("lightbar")) { const n = v("lightbar") === "off" ? "flash" : "off"; stage.setPart(id, "lightbar", n); say(`Light bar: ${optionsOf("lightbar")[n]}.`); return true; }
  if (k === "i" && chans.includes("indicator")) { const n = NEXT.indicator[v("indicator")] || "left"; stage.setPart(id, "indicator", n); say(`Indicators: ${optionsOf("indicator")[n]}.`); return true; }
  if (k === "o" && chans.includes("door_fl")) {
    const doors = e.shiftKey ? chans.filter((c) => /^door_|^hood$|^trunk$/.test(c)) : ["door_fl"];
    const open = doors.some((d) => (v(d) || 0) < 5);   // anything shut: open them all; all open: shut them all
    stage.setParts(id, Object.fromEntries(doors.map((d) => [d, open ? (d === "hood" || d === "trunk" ? 70 : 65) : 0])));
    say(`${e.shiftKey ? "Every door" : "Driver's door"} ${open ? "open" : "closed"}${stage.partChannels(id).find((c) => c.ch === doors[0])?.keys.length > 1 ? ` (keyed at frame ${stage.frame})` : ""}.`);
    return true;
  }
  if (k === "k" && !e.shiftKey && chans.length) { const n = stage.keyAllParts(id); say(n ? `Keyed ${n} parts at frame ${stage.frame}.` : "Every part already has a key here."); return true; }
  return false;
}

/**
 * Wire the Parts sections into the App (web/soundstage.js calls this once): the selected object's (above Pose
 * Studio), the selected film light's (in its card) and the shot camera's (in Lens & rig); the viewport keys; the
 * timeline redraw. Chains the stage's onSelect / onSelectLight, so it must run before the workspace wraps them.
 */
export function mountParts({ stage, poseHost, posePanel, lightSel, lensRow, onStatus = () => {}, onKeys = () => {} }) {
  const obj = new PartsPanel(poseHost, { stage, onStatus, title: "Parts", posePanel });
  poseHost.prepend(obj.el);
  const light = new PartsPanel(lightSel, { stage, onStatus, title: "Light over time" });
  const cam = new PartsPanel(lensRow, { stage, onStatus, title: "Lens channels (keyable)", fixedId: "__camera__" });
  const onSel0 = stage.onSelect, onLight0 = stage.onSelectLight, onParts0 = stage.onParts;
  stage.onSelect = (info) => { onSel0?.(info); try { obj.bind(info?.id || null, info?.name); } catch (err) { console.warn("Soundstage parts", err); } };
  stage.onSelectLight = (l) => { onLight0?.(l); try { light.bind(l ? `light:${l.id}` : null, l?.name); } catch (err) { console.warn("Soundstage parts", err); } };
  stage.onParts = () => { onParts0?.(); try { onKeys(); } catch { /* timeline not built */ } };
  stage.canvas.addEventListener("keydown", (e) => {
    try { if (partsKey(stage, e, onStatus)) { e.preventDefault(); e.stopPropagation(); obj.refresh(true); onKeys(); } }
    catch (err) { console.warn("Soundstage parts key", err); }
  });
  obj.bind(stage.selected || null);
  return { obj, light, cam };
}

export { specOf };
