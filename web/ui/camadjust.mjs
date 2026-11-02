// The Adjust panel: a small card over the canvas that shows the active shot's camera preset with its own numbers
// (height, distance, angle, speed, lens; for a car mount the mount, its side, forward / up / out, turn, tilt and lens),
// so a preset is a starting point you tweak instead of rebuild. It opens after a camera preset is applied (and from the
// toast's Adjust), and each slider you let go of re-keys the move from the same starting camera as one undo step
// (web/presets/runner.mjs adjust). The keys stay ordinary keys: drag them in the Top view, move the camera with the
// gizmo, retime them on the timeline. If you did, the panel says so: an Adjust then replaces those edits (⌘Z undoes it).
//
//   import { mountCamAdjust } from "./camadjust.mjs";
//   const adj = mountCamAdjust({ root, runner, onChange });  adj.open(); adj.refresh(); adj.close();
import { FONT, TOKENS as T, RADIUS } from "./theme.mjs";
import { icon } from "./icons.mjs";
import { adjustSummary } from "../presets/adjust.mjs";

const CSS = `
.ss-adj { position:absolute; right:12px; bottom:74px; z-index:83; width:min(280px, calc(100% - 24px)); max-height:calc(100% - 150px);
  overflow:auto; background:${T.glassStrong}; color:${T.text}; border:1px solid ${T.lineStrong}; border-radius:${RADIUS.lg}px;
  box-shadow:0 18px 48px rgba(0,0,0,.5); backdrop-filter:blur(12px); font:12px/1.35 ${FONT}; padding:10px 12px 12px; scrollbar-width:thin; }
.ss-adj, .ss-adj * { box-sizing:border-box; }
.ss-adj[hidden] { display:none !important; }
.ss-adj-h { display:flex; align-items:center; gap:8px; margin-bottom:6px; }
.ss-adj-h .t { flex:1 1 auto; min-width:0; font-weight:600; font-size:13px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ss-adj-h .t .ss-icon { color:${T.accent}; vertical-align:-2px; margin-right:5px; }
.ss-adj .ib { width:24px; height:24px; display:inline-flex; align-items:center; justify-content:center; border-radius:7px; cursor:pointer;
  background:transparent; color:${T.muted}; border:1px solid transparent; padding:0; flex:none; }
.ss-adj .ib:hover { background:rgba(255,255,255,.07); color:${T.text}; }
.ss-adj-row { display:grid; grid-template-columns:62px 1fr 54px; align-items:center; gap:8px; padding:3px 0; }
.ss-adj-row label { color:${T.muted}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ss-adj-row input[type=range] { width:100%; accent-color:${T.accent}; margin:0; }
.ss-adj-row output { text-align:right; font-variant-numeric:tabular-nums; color:${T.text}; white-space:nowrap; }
.ss-adj-row select { grid-column:2 / 4; width:100%; background:rgba(0,0,0,.25); color:${T.text}; border:1px solid ${T.line}; border-radius:8px;
  padding:4px 6px; font:inherit; }
.ss-adj-seg { grid-column:2 / 4; display:flex; gap:4px; }
.ss-adj-seg button, .ss-adj-foot button { flex:1 1 0; border-radius:999px; padding:4px 8px; border:1px solid ${T.line}; background:rgba(255,255,255,.05);
  color:${T.muted}; cursor:pointer; font:500 12px/1.2 ${FONT}; }
.ss-adj-seg button[aria-pressed=true] { background:${T.accent}; color:${T.accentInk}; border-color:${T.accent}; }
.ss-adj-note { margin:4px 0 6px; color:${T.faint}; font-size:11px; }
.ss-adj-note.warn { color:${T.danger}; }
.ss-adj-foot { display:flex; gap:6px; margin-top:8px; }
.ss-adj-foot button:hover, .ss-adj-seg button:hover { color:${T.text}; border-color:${T.lineStrong}; }
.ss-adj-empty { color:${T.muted}; padding:4px 0; }
`;

const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k != null) e.append(k);
  return e;
};

/** How a control's value reads in the panel. */
export function fmtValue(c, v) {
  if (v == null || !Number.isFinite(+v)) return c.key === "focal_mm" || c.key === "lens_mm" ? "as set" : "";
  const n = +v, d = c.step < 0.1 ? 2 : c.step < 1 ? 1 : 0;
  return `${c.rel && n > 0 ? "+" : ""}${n.toFixed(d)}${c.unit === "×" || c.unit === "°" ? c.unit : ` ${c.unit}`}`;
}

export function mountCamAdjust({ root, runner, onChange = null, say = null }) {
  if (!document.getElementById("ss-adj-css")) document.head.append(h("style", { id: "ss-adj-css" }, CSS));
  const title = h("span", { class: "t" });
  const closeB = h("button", { type: "button", class: "ib", title: "Close", "aria-label": "Close the Adjust panel" }, icon("x", 14));
  const body = h("div");
  const note = h("div", { class: "ss-adj-note" });
  const resetB = h("button", { type: "button", title: "Back to the preset's own numbers" }, "Reset");
  const foot = h("div", { class: "ss-adj-foot" }, resetB);
  const el = h("section", { class: "ss-adj", hidden: true, role: "dialog", "aria-label": "Adjust the camera preset" },
    h("div", { class: "ss-adj-h" }, title, closeB), note, body, foot);
  for (const ev of ["pointerdown", "wheel", "keydown", "keyup", "contextmenu"]) el.addEventListener(ev, (e) => e.stopPropagation(), { passive: ev === "wheel" });
  root.append(el);
  let busy = false, state = null;

  async function change(patch) {
    if (busy) return;
    busy = true;
    try {
      const r = await runner.adjust(patch);
      if (!r.ok) { note.textContent = r.said; note.className = "ss-adj-note warn"; }
      try { onChange?.(r); } catch { /* listener */ }
      if (r.ok) say?.(r.said);
    } finally { busy = false; refresh(); }
  }

  function row(c) {
    if (c.type === "select") {
      const sel = h("select", { "aria-label": c.label, title: c.hint || c.label });
      let group = null, og = null;
      for (const m of state.mounts || []) {
        if (m.group !== group) { group = m.group; og = h("optgroup", { label: group }); sel.append(og); }
        og.append(new Option(m.label, m.id, false, m.id === c.value));
      }
      sel.addEventListener("change", () => change({ view: sel.value, side: 1, out_m: 0, up_m: 0, fwd_m: 0, yaw_deg: 0, tilt_deg: 0, focal_mm: null }));
      return h("div", { class: "ss-adj-row" }, h("label", { title: c.hint }, c.label), sel);
    }
    if (c.type === "side") {
      const sided = (state.mounts || []).find((m) => m.id === state.values.view)?.sided;
      if (!sided) return null;
      const b = (v, lbl) => h("button", { type: "button", "aria-pressed": String((+c.value === -1 ? -1 : 1) === v), onclick: () => change({ side: v }) }, lbl);
      return h("div", { class: "ss-adj-row" }, h("label", { title: c.hint }, c.label), h("div", { class: "ss-adj-seg" }, b(1, "Left (driver)"), b(-1, "Right")));
    }
    const lensUnset = c.value == null;
    const start = lensUnset ? (c.key === "lens_mm" ? (runner.scene().shots?.find((s) => s.id === runner.shotInfo().id)?.camera_keys?.[0]?.focal_mm ?? 35) : 24) : c.value;
    const inp = h("input", { type: "range", min: String(c.min), max: String(c.max), step: String(c.step), value: String(start), "aria-label": c.label, title: c.hint || c.label });
    const out = h("output", {}, lensUnset ? fmtValue(c, null) : fmtValue(c, start));
    inp.addEventListener("input", () => { out.textContent = fmtValue(c, +inp.value); });
    inp.addEventListener("change", () => change({ [c.key]: +inp.value }));
    return h("div", { class: "ss-adj-row" }, h("label", { title: c.hint }, c.label), inp, out);
  }

  function refresh() {
    if (el.hidden) return;
    state = runner.adjustState();
    body.replaceChildren();
    if (!state) {
      title.replaceChildren(icon("sliders-horizontal", 14), "Adjust");
      note.className = "ss-adj-note";
      note.textContent = "";
      body.append(h("div", { class: "ss-adj-empty" }, "Apply a camera preset (Presets, V) or pick a car mount, then fine-tune it here."));
      foot.hidden = true;
      return;
    }
    foot.hidden = false;
    title.replaceChildren(icon("sliders-horizontal", 14), `Adjust · ${state.label}`);
    note.className = state.edited ? "ss-adj-note warn" : "ss-adj-note";
    note.textContent = state.edited
      ? "You edited these keys by hand. Adjusting re-keys the move and replaces those edits (⌘Z brings them back)."
      : (adjustSummary(state.controls) || "Let go of a slider to re-key the move. The keys stay editable on the stage.");
    body.append(...state.controls.map(row).filter(Boolean));
  }

  resetB.addEventListener("click", () => {
    if (!state) return;
    const v = {};
    for (const c of state.controls) if (c.type == null) v[c.key] = c.kind === "spec" ? c.def : c.def ?? null;
    if (state.move === "car_mount") Object.assign(v, { side: 1, out_m: 0, up_m: 0, fwd_m: 0, yaw_deg: 0, tilt_deg: 0, focal_mm: null });
    change(v);
  });
  closeB.addEventListener("click", () => close());
  el.addEventListener("pointerenter", () => { if (!busy) refresh(); });   // after edits made elsewhere (keys, shots)

  function open() { el.hidden = false; refresh(); }
  function close() { el.hidden = true; }
  return { el, open, close, refresh, isOpen: () => !el.hidden, destroy() { el.remove(); } };
}
