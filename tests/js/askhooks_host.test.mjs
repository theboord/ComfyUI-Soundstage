// node --test tests/js/askhooks_host.test.mjs
// Hooks the App hands Ask's host (web/hosthooks.mjs, wired in web/soundstage.js's mountAsk host):
//   host.project()     async -> {name, id}: the open project, id "p_<8hex>" only when confirmed, else null
//   host.cut.panel()   the live CutPanel instance, null when the Cut isn't mounted
// All test data is invented.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { projectHook, cutPanelHook } from "../../web/hosthooks.mjs";

const SRC = readFileSync(new URL("../../web/soundstage.js", import.meta.url), "utf8");
const askHost = () => { const a = SRC.indexOf("node.ssAsk = mountAsk("); return SRC.slice(a, SRC.indexOf("mountProjectBar(", a)); };

test("Ask's host gets project, cut.panel (the App's CutPanel and its view)", () => {
  const ask = askHost();
  assert.match(ask, /project: projectHook\(\)/);
  assert.match(ask, /panel: cutPanelHook\(cut, cutView\)/);
  assert.match(SRC, /const cut = new CutPanel\(cutView,/);
});

test("host.project(): the confirmed id from window.__ssProject.project(), else null; never throws", async () => {
  const ctl = (r) => ({ project: async () => r, projectId: () => "p_0badc0de", current: () => ({ id: "p_0badc0de", name: "Fallback" }) });
  assert.deepEqual(await projectHook(() => ctl({ id: "p_1a2b3c4d", name: "Night Market", confirmed: true }))(), { name: "Night Market", id: "p_1a2b3c4d" });
  assert.deepEqual(await projectHook(() => ctl({ id: "p_1a2b3c4d", name: "Night Market", confirmed: false }))(), { name: "Night Market", id: null }, "unconfirmed: null");
  assert.deepEqual(await projectHook(() => ctl({ id: "x_123", name: "Odd", confirmed: true }))(), { name: "Odd", id: null }, "not p_<8hex>: null");
  assert.deepEqual(await projectHook(() => ctl({ id: null, name: null, confirmed: false }))(), { name: "Fallback", id: null }, "an unsaved tab keeps its tab name");
  const failing = { project: async () => { throw new Error("offline"); }, projectId: () => "p_00ff00ff", current: () => ({ name: "Offline Pic" }) };
  assert.deepEqual(await projectHook(() => failing)(), { name: "Offline Pic", id: "p_00ff00ff" }, "a failed read: the sync answer");
  assert.deepEqual(await projectHook(() => undefined)(), { name: null, id: null }, "no controller");
  globalThis.__ssProject = ctl({ id: "p_deadbeef", name: "Global", confirmed: true });
  try { assert.deepEqual(await projectHook()(), { name: "Global", id: "p_deadbeef" }, "defaults to window.__ssProject"); }
  finally { delete globalThis.__ssProject; }
});

test("host.cut.panel(): the very CutPanel object while mounted, null when not", () => {
  const cut = { seek() {}, fps: 24 }, view = { isConnected: true };
  const panel = cutPanelHook(cut, view);
  assert.equal(panel(), cut, "the live instance, not a copy");
  view.isConnected = false;
  assert.equal(panel(), null);
  assert.equal(cutPanelHook(null, { isConnected: true })(), null);
});
