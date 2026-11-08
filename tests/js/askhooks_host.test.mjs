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

test("host.cut.panel(): the very CutPanel object while the Cut is mounted and shown, null when not", () => {
  const cut = { seek() {}, fps: 24 }, view = { isConnected: true, hidden: false };
  const panel = cutPanelHook(cut, view);
  assert.equal(panel(), cut, "the live instance, not a copy");
  view.hidden = true;
  assert.equal(panel(), null, "built but hidden (another step is open): null");
  view.hidden = false;
  assert.equal(panel(), cut);
  view.isConnected = false;
  assert.equal(panel(), null, "out of the page: null");
  assert.equal(cutPanelHook(null, { isConnected: true, hidden: false })(), null);
});

test("the App builds the Cut view hidden and shows it only on the Cut step (what panel() keys on)", () => {
  assert.match(SRC, /cutView\.hidden = true;/);
  assert.match(SRC, /cutView\.hidden = k !== "cut";/);
});

test("host.project() always settles: a read that hangs resolves {name, id: null} after the timeout", async () => {
  const hang = { project: () => new Promise(() => {}), projectId: () => "p_1a2b3c4d", current: () => ({ name: "Night Market" }) };
  const t0 = Date.now();
  assert.deepEqual(await projectHook(() => hang, { timeoutMs: 50 })(), { name: "Night Market", id: null }, "no unconfirmed id");
  assert.ok(Date.now() - t0 < 1000, "settled at the timeout");
  const slow = { project: () => new Promise((r) => setTimeout(() => r({ id: "p_1a2b3c4d", name: "Night Market", confirmed: true }), 10)) };
  assert.deepEqual(await projectHook(() => slow, { timeoutMs: 500 })(), { name: "Night Market", id: "p_1a2b3c4d" }, "an answer in time is used");
  const syncThrow = { project: () => { throw new Error("boom"); }, current: () => ({ name: "Sync" }) };
  assert.deepEqual(await projectHook(() => syncThrow)(), { name: "Sync", id: null }, "a sync throw is caught too");
  const hangNoName = { project: () => new Promise(() => {}), current: () => { throw new Error("x"); } };
  assert.deepEqual(await projectHook(() => hangNoName, { timeoutMs: 10 })(), { name: null, id: null });
});
