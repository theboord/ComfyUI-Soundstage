// Models panel opened twice: the first panel is closed (poll stopped, out of the key guard), so once the second one
// closes every key reaches the App again. A dialog removed some other way doesn't keep keys blocked either.
// A tiny fake DOM is enough: the try-it demo flag makes the panel skip the server, and the catalog fetch fails.
import { test } from "node:test";
import assert from "node:assert/strict";

class FakeEl extends EventTarget {
  constructor(tag) { super(); this.tagName = tag.toUpperCase(); this.children = []; this.parent = null; this.attrs = {}; }
  get isConnected() { let n = this; while (n.parent) n = n.parent; return n === doc.documentElement; }
  get lastChild() { return this.children.at(-1) ?? null; }
  get id() { return this.attrs.id ?? ""; }
  set id(v) { this.attrs.id = v; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  append(...kids) { for (const k of kids) { if (typeof k === "string") continue; k.remove(); k.parent = this; this.children.push(k); } }
  prepend(...kids) { this.append(...kids); }
  replaceChildren(...kids) { for (const c of [...this.children]) c.remove(); this.append(...kids); }
  remove() { if (this.parent) { this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; } }
  querySelectorAll() { return []; }
  querySelector() { return null; }
  focus() {}
}
const doc = {
  documentElement: new FakeEl("html"), head: new FakeEl("head"), body: new FakeEl("body"), activeElement: null,
  createElement: (t) => new FakeEl(t),
  getElementById(id) {
    const walk = (n) => { if (n.id === id) return n; for (const c of n.children) { const r = walk(c); if (r) return r; } return null; };
    return walk(doc.documentElement);
  },
};
doc.documentElement.append(doc.head, doc.body);
const win = new EventTarget();
globalThis.document = doc;
globalThis.window = win;
globalThis.__demo = { app: 1 };                                 // no server: no request is made
globalThis.fetch = async () => { throw new Error("offline"); }; // the catalog can't load either: a one-line message

const { openModels, openPanels } = await import("../../web/models/panel.mjs");

const appKeys = [];
win.addEventListener("keydown", (e) => appKeys.push(e.key), true);   // an App listener, added after the guard
const key = (k) => { const e = new Event("keydown", { cancelable: true }); e.key = k; win.dispatchEvent(e); return e; };
const settle = () => new Promise((r) => setTimeout(r, 0));

test("open twice, close: keys reach the App again", async () => {
  const a = openModels();
  await settle();
  const b = openModels();
  await settle();
  assert.equal(openPanels.size, 1, "the first panel was closed when the second opened");
  assert.ok(openPanels.has(b) && !openPanels.has(a));
  assert.equal(a.root.isConnected, false);
  assert.equal(doc.body.children.filter((c) => c.id === "ss-models").length, 1);
  key("h");
  assert.deepEqual(appKeys, [], "blocked while the second panel is open");
  b.close();
  assert.equal(openPanels.size, 0);
  key("h");
  assert.deepEqual(appKeys, ["h"], "closed: the key reaches the App");
});

test("a dialog removed some other way doesn't keep keys blocked", async () => {
  appKeys.length = 0;
  const p = openModels();
  await settle();
  key("z");
  assert.deepEqual(appKeys, []);
  p.root.remove();                                              // not via close()
  key("z");
  assert.deepEqual(appKeys, ["z"]);
  assert.equal(openPanels.size, 0, "the stale panel was dropped");
});

test("focus left on the App behind the dialog: Space / Enter don't click it, focus moves into the dialog", async () => {
  appKeys.length = 0;
  const appBtn = new FakeEl("button");
  doc.body.append(appBtn);
  let focused = null;
  const first = new FakeEl("button");
  first.focus = () => { focused = first; };
  const panel = {
    root: { isConnected: true, contains: (n) => n === first },
    box: { querySelectorAll: () => [first] },
    close() { openPanels.delete(this); },
  };
  openPanels.add(panel);
  doc.activeElement = appBtn;                                   // the project-menu button that opened the panel
  for (const k of [" ", "Enter"]) {
    focused = null;
    const e = key(k);
    assert.equal(e.defaultPrevented, true, `${JSON.stringify(k)} would click the App button behind the modal`);
    assert.equal(focused, first, "focus goes into the dialog");
  }
  doc.activeElement = first;                                    // inside the dialog: default actions still happen
  assert.equal(key(" ").defaultPrevented, false);
  assert.deepEqual(appKeys, []);
  panel.close();
  doc.activeElement = null;
  appBtn.remove();
});

test("open takes focus off the App; close gives it back", async () => {
  const appBtn = new FakeEl("button");
  doc.body.append(appBtn);
  let got = [];
  appBtn.focus = () => got.push("app");
  doc.activeElement = appBtn;
  const p = openModels();
  await settle();
  assert.equal(p.back, appBtn);
  assert.equal(p.box.tabIndex, -1);
  p.root.contains = (n) => n === p.box;                         // fake DOM: focus sits on the dialog box
  doc.activeElement = p.box;
  p.close();
  assert.deepEqual(got, ["app"]);
  doc.activeElement = null;
  appBtn.remove();
});
