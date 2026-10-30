// Stand-in for ComfyUI's scripts/app.js: just enough graph for the real Soundstage App widget to run in a static page.
import { api } from "./api.js";

class Widget {
  constructor(name, value, options = {}) { this.name = name; this.value = value; this.options = options; }
  callback() {}
}

class Node {
  constructor(id, type, title, widgets = []) {
    this.id = id; this.type = type; this.comfyClass = type; this.title = title;
    this.widgets = widgets; this.properties = {}; this.graph = null;
  }
  /** ComfyUI's DOM widget: the shell mounts `el`; value goes through the widget's getValue/setValue. */
  addDOMWidget(name, type, el, opts = {}) {
    const w = { name, type, element: el, options: opts,
      get value() { return opts.getValue?.(); }, set value(v) { opts.setValue?.(v); } };
    this.widgets.push(w);
    this.domWidget = w;
    return w;
  }
}

const graph = {
  _nodes: [],
  links: {},
  getNodeById(id) { return this._nodes.find((n) => n.id === +id) || null; },
  setDirtyCanvas() {},
  add(n) { n.graph = this; this._nodes.push(n); return n; },
};

export const app = {
  extensions: [],
  graph,
  Node, Widget,
  registerExtension(ext) { this.extensions.push(ext); },
  extensionManager: {
    workflow: { activeWorkflow: { path: "workflows/demo.json", isModified: false, changeTracker: { checkState() {} } } },
  },
  /** Run: queue through api.queuePrompt (the App wraps it to learn which shot each prompt is for). */
  async queuePrompt() { return api.queuePrompt(0, {}); },
};
