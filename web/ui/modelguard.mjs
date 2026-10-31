// When a Soundstage workflow loads: point loader widgets at the model builds this install has, and say so.
// The matching itself is pure and tested (modelmatch.mjs); this file walks the live graph and draws the notice.
import { MODELS_DOC_URL, isModelFile, noticeLines, planModelFixes } from "./modelmatch.mjs";

/** Every node of the graph and of its subgraph definitions (the "Load Models" subgraph holds the LTX loaders). */
export function allNodes(graph) {
  const out = [];
  const seen = new Set();
  const visit = (g, where) => {
    if (!g || seen.has(g)) return;
    seen.add(g);
    for (const n of g._nodes || g.nodes || []) out.push({ n, where });
    const subs = g.subgraphs;
    const list = !subs ? [] : typeof subs.values === "function" ? [...subs.values()] : Object.values(subs);
    for (const sg of list) visit(sg, sg.name || "subgraph");
  };
  visit(graph, "");
  return out;
}

const optionList = (w) => {
  let v = w?.options?.values;
  if (typeof v === "function") { try { v = v(w); } catch { v = null; } }
  return Array.isArray(v) ? v : null;
};

const linkOf = (g, id) => {
  const L = g?.links ?? g?._links;
  if (!L) return null;
  return (typeof L.get === "function" ? L.get(id) : L[id]) || null;
};

/**
 * Is this widget fed by another node's output? A widget wired to its subgraph's input slot is not: that slot is the
 * subgraph's own (promoted) widget, and the loader's value is what gets queued.
 */
export function fedByWire(n, w) {
  const inp = (n.inputs || []).find((i) => i.widget?.name === w.name && i.link != null);
  if (!inp) return false;
  const l = linkOf(n.graph, inp.link);
  const origin = l ? (l.origin_id ?? (Array.isArray(l) ? l[1] : undefined)) : undefined;
  return !(typeof origin === "number" && origin < 0);
}

/** Loader widgets: combos holding a model file name whose value is typed in (not fed by another node). */
export function loaderWidgets(graph) {
  const items = [];
  for (const { n, where } of allNodes(graph)) {
    if (n.mode === 2 || n.mode === 4) continue;           // muted / bypassed: never validated
    for (const w of n.widgets || []) {
      if (!isModelFile(w.value)) continue;
      if (fedByWire(n, w)) continue;                       // the value comes down the wire
      const options = optionList(w);
      if (!options) continue;
      const label = [n.title || n.type, where].filter(Boolean).join(" · ");
      items.push({ id: w, node: label, widget: w.name, value: w.value, options });
    }
  }
  return items;
}

/** Fix what can be fixed; returns the plan (swaps applied in place). */
export function guardModels(graph) {
  const plan = planModelFixes(loaderWidgets(graph));
  for (const s of plan.swaps) s.id.value = s.to;
  return plan;
}

const shownMissing = new Set();

/** The small card in the corner. Swaps fade on their own; a missing file stays until closed. */
export function showModelNotice(plan, doc = globalThis.document) {
  if (!doc) return null;
  const { swaps, missing } = noticeLines(plan);
  const fresh = missing.filter((m) => !shownMissing.has(m));
  if (!swaps.length && !fresh.length) return null;
  for (const m of missing) shownMissing.add(m);
  doc.getElementById("ss-model-notice")?.remove();
  if (!doc.getElementById("ss-model-notice-css")) {
    const css = doc.createElement("style");
    css.id = "ss-model-notice-css";
    css.textContent = `#ss-model-notice{position:fixed;right:16px;bottom:16px;z-index:100001;max-width:min(460px,calc(100vw - 32px));
background:#1c1a22;color:#ece9f2;border:1px solid #3a3644;border-radius:12px;padding:12px 14px 12px 14px;
font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.45)}
#ss-model-notice b{display:block;font-size:12px;letter-spacing:.02em;color:#b9b3c7;margin-bottom:4px;font-weight:600}
#ss-model-notice ul{margin:0;padding:0 0 0 16px}#ss-model-notice li{margin:2px 0;word-break:break-word}
#ss-model-notice li.miss{color:#ffb4a8}#ss-model-notice a{color:#9cc8ff}
#ss-model-notice button{position:absolute;top:6px;right:8px;background:none;border:none;color:#b9b3c7;font-size:16px;cursor:pointer;padding:2px 6px}`;
    doc.head.append(css);
  }
  const box = doc.createElement("div");
  box.id = "ss-model-notice";
  box.setAttribute("role", "status");
  const title = doc.createElement("b");
  title.textContent = missing.length ? "Model files" : "Model files: using what you have";
  const ul = doc.createElement("ul");
  for (const t of swaps) { const li = doc.createElement("li"); li.textContent = t; ul.append(li); }
  for (const t of missing) { const li = doc.createElement("li"); li.className = "miss"; li.textContent = t; ul.append(li); }
  box.append(title, ul);
  if (missing.length) {
    const p = doc.createElement("div");
    p.style.marginTop = "6px";
    p.append("Drafts and finals that need it won't render. Where to get it: ");
    const a = doc.createElement("a");
    a.href = MODELS_DOC_URL; a.target = "_blank"; a.rel = "noopener"; a.textContent = "MODELS.md";
    p.append(a);
    box.append(p);
  }
  const x = doc.createElement("button");
  x.type = "button"; x.textContent = "×"; x.setAttribute("aria-label", "Close");
  x.onclick = () => box.remove();
  box.append(x);
  doc.body.append(box);
  if (!missing.length) setTimeout(() => box.remove(), 15000);
  return box;
}
