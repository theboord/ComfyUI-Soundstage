// ✦ One-click › Hand-off › Open in ComfyUI: the exact graph that made a take, opened as a new ComfyUI workflow tab (the
// App's own tab is left as it is), or downloaded as JSON. No GPU, no re-render: ComfyUI wrote the graph into the file
// when it saved it (the `workflow` tag when it was queued from a canvas, else the API `prompt` tag; the App's renders
// are API prompts). GET /soundstage/handoff/workflow?ref= reads it (soundstage/handoff/workflow.py).
import { registerOneClick } from "./oneclick.mjs";

export async function fetchGraph(api, ref) {
  const r = await api.fetchApi(`/soundstage/handoff/workflow?ref=${encodeURIComponent(ref)}`);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error || (r.status === 404 ? "this server needs a restart to know the hand-off route" : `HTTP ${r.status}`));
  if (!j.kind) throw new Error(j.why || "no ComfyUI graph inside this file");
  return j;
}

/** The tab name: "✦ draft_00115_" (ComfyUI adds .json). */
export const tabName = (g) => `✦ ${String(g?.name || "take").replace(/[^\w .()-]+/g, "_").slice(0, 60)}`;

/** The bounding box [x, y, w, h] of a graph's nodes (null when empty). */
export function nodeBounds(nodes = []) {
  if (!nodes.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of nodes) {
    const [x, y] = n.pos || [0, 0], [w, h] = n.size || [200, 100];
    x0 = Math.min(x0, x); y0 = Math.min(y0, y - 30); x1 = Math.max(x1, x + w); y1 = Math.max(y1, y + h);
  }
  return [x0, y0, x1 - x0, y1 - y0];
}

/** Frame every node of the open graph (an API graph is laid out fresh, far from the App's view). */
export function fitAll(app) {
  try {
    const b = nodeBounds(app.graph?._nodes || []);
    if (b && app.canvas?.ds?.fitToBounds) { app.canvas.ds.fitToBounds(b); app.canvas.setDirty?.(true, true); }
  } catch { /* a view nicety only */ }
}

/** Open a graph in a new workflow tab. app = ComfyUI's app object. Returns "workflow" | "api". */
export async function openGraph(app, g) {
  if (g.kind === "workflow" && g.workflow) {
    await app.loadGraphData(structuredClone(g.workflow), true, true, tabName(g));
    return "workflow";
  }
  if (g.prompt && typeof app.loadApiJson === "function") {
    await app.loadApiJson(structuredClone(g.prompt), tabName(g));
    fitAll(app);
    return "api";
  }
  throw new Error("this ComfyUI can't open API graphs: use Download the graph");
}

/** Files to download: [{name, data}] (the UI workflow and/or the API prompt). */
export function graphFiles(g) {
  const base = String(g?.name || "take").replace(/[^\w.-]+/g, "_");
  const out = [];
  if (g?.workflow) out.push({ name: `${base}.workflow.json`, data: g.workflow });
  if (g?.prompt) out.push({ name: `${base}.api.json`, data: g.prompt });
  return out;
}

export function download(name, data, doc = globalThis.document) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = doc.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  doc.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

registerOneClick({
  id: "open_comfy", group: "Hand-off", label: "Open in ComfyUI", order: 0, gpu: false,
  hint: "The exact graph that made this, in a new workflow tab: every node and setting, ready to tweak",
  applies: ["still", "clip"], keywords: ["comfyui", "workflow", "graph", "nodes", "open", "json"],
  async run(target, ctx) {
    const g = await fetchGraph(ctx.api, target.ref);
    const { app } = await import("../../../scripts/app.js");
    const how = await openGraph(app, g);
    ctx.say?.(`Opened ${g.nodes} nodes in a new ComfyUI tab (${how === "workflow" ? "the canvas it was queued from" : "the API graph it was rendered with"}). The App's tab is unchanged.`);
    return null;
  },
});

registerOneClick({
  id: "download_graph", group: "Hand-off", label: "Download the graph", order: 1, gpu: false,
  hint: "The workflow (UI) and the API prompt as JSON files, to keep, share or run elsewhere",
  applies: ["still", "clip"], keywords: ["download", "json", "workflow", "api"],
  async run(target, ctx) {
    const g = await fetchGraph(ctx.api, target.ref);
    const files = graphFiles(g);
    files.forEach((f) => download(f.name, f.data));
    ctx.say?.(`Downloaded ${files.map((f) => f.name).join(" and ")}.`);
    return null;
  },
});

export const OPENCOMFY_IDS = ["open_comfy", "download_graph"];
