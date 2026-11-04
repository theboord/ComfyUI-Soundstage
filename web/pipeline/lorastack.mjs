// A stack of LoRA rows ("＋ Add LoRA"): each row a LoRA select (the ones that fit the model first, the rest marked "may not
// work with this model", never blocked), a strength slider and a ✕. Shared by ④ Frame and ⑤ Motion › Advanced (LTX).
// The widget keeps its own rows (a freshly added row is blank until picked) and reports only the picked ones, in order.
import { normalizeStack } from "./loras.mjs";

/** opts: h (the element builder), groups(current) -> {match, other}, warn(name) -> string, onChange(rows), matchLabel, otherLabel,
 *  min, max, step, fallback (default strength). */
export function createLoraStack(opts) {
  const { h } = opts;
  const min = opts.min ?? -2, max = opts.max ?? 2, step = opts.step ?? 0.05, dflt = opts.fallback ?? 0.8;
  const el = h("div", { class: "ss-lorastack" });
  const list = h("div", { class: "ss-lorarows" });
  const addBtn = h("button", { type: "button", class: "ghost", on: { click: () => { rows.push({ name: "None", strength: dflt }); draw(); } } }, "＋ Add LoRA");
  const note = h("small", { class: "status ss-lorawarn", role: "status" });
  el.append(list, addBtn, note);
  let rows = [], disabled = false, why = "";
  const emit = () => { try { opts.onChange?.(rows.filter((r) => r.name && r.name !== "None").map((r) => ({ name: r.name, strength: r.strength }))); } catch { /* no store */ } };
  const warnings = () => rows.map((r) => opts.warn?.(r.name)).filter(Boolean);
  const showNote = () => { note.textContent = disabled ? why : [...new Set(warnings())].join(" "); };
  const option = (v, t) => { const o = h("option", { value: v }, t ?? String(v).replace(/\.safetensors$/, "")); return o; };
  function draw() {
    list.replaceChildren(...rows.map((r, i) => {
      const g = opts.groups?.(r.name) || { match: [], other: [] };
      const sel = h("select", { "aria-label": `LoRA ${i + 1}`, on: { change: () => { r.name = sel.value; showNote(); emit(); } } },
        option("None", "Pick a LoRA…"),
        ...(g.match.length ? [h("optgroup", { label: opts.matchLabel || "Matches this model" }, ...g.match.map((x) => option(x)))] : []),
        ...(g.other.length ? [h("optgroup", { label: opts.otherLabel || "Other LoRAs (may not work with this model)" }, ...g.other.map((x) => option(x)))] : []));
      sel.value = r.name && r.name !== "None" ? r.name : "None";
      if (sel.value !== r.name && r.name !== "None") { sel.append(option(r.name)); sel.value = r.name; }   // the shot's own pick stays listed even if the file is gone
      const out = h("span", { class: "status" }, r.strength.toFixed(2));
      const rng = h("input", { type: "range", min: String(min), max: String(max), step: String(step), value: String(r.strength), "aria-label": `LoRA ${i + 1} strength`,
        on: { input: () => { r.strength = +rng.value; out.textContent = r.strength.toFixed(2); emit(); } } });
      const del = h("button", { type: "button", class: "ghost", title: "Remove this LoRA", "aria-label": `Remove LoRA ${i + 1}`,
        on: { click: () => { rows.splice(i, 1); draw(); emit(); } } }, "✕");
      for (const c of [sel, rng, del]) c.disabled = disabled;
      return h("div", { class: "row ss-lorarow" }, sel, rng, out, del);
    }));
    addBtn.disabled = disabled;
    showNote();
  }
  draw();
  return {
    el,
    /** Replace the rows (a shot loaded, or a workflow's saved stack). Does not call onChange. */
    set(raw) { rows = normalizeStack(raw).map((r) => ({ ...r })); draw(); },
    get() { return normalizeStack(rows); },
    /** The LoRA list or the model changed: rebuild the groups, keep the rows. */
    refresh() { draw(); },
    setDisabled(v, reason = "") { disabled = !!v; why = reason; draw(); },
  };
}
