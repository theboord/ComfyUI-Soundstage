// node --test tests/js/   (Projects: save / open round trip, autosave rotation and restore, the status pill, names; the
// pure half in web/project/store.mjs, against an in-memory stand-in for ComfyUI's userdata API)
import test from "node:test";
import assert from "node:assert/strict";

import {
  ProjectStore, AutosaveClock, cleanName, untitledName, autosaveStamp, stampDate, statusText, workflowSig, projectNameOf, ago,
} from "../../web/project/store.mjs";

/** ComfyUI's userdata API (scripts/api.js) over a Map: storeUserData / getUserData / listUserDataFullInfo / deleteUserData. */
function fakeApi() {
  const files = new Map();
  let tick = 0;
  return {
    files,
    async storeUserData(path, data, { overwrite = true, stringify = true } = {}) {
      if (!overwrite && files.has(path)) return { ok: false, status: 409 };
      files.set(path, { body: stringify ? JSON.stringify(data) : data, modified: ++tick });
      return { ok: true, status: 200 };
    },
    async getUserData(path) {
      const f = files.get(path);
      return f ? { ok: true, status: 200, json: async () => JSON.parse(f.body) } : { ok: false, status: 404 };
    },
    async listUserDataFullInfo(dir) {
      const pre = `${dir}/`;
      return [...files.entries()].filter(([p]) => p.startsWith(pre)).map(([p, f]) => ({ path: p.slice(pre.length), size: f.body.length, modified: f.modified }));
    },
    async deleteUserData(path) { files.delete(path); return { ok: true, status: 204 }; },
  };
}

const WF = () => ({ last_node_id: 2, nodes: [{ id: 1, type: "SoundstageStage", properties: { ss_ltx: { sh_a: { steps: 8 } } }, widgets_values: ["{}"] }],
  links: [], extra: { ds: { scale: 1, offset: [0, 0] } }, version: 0.4 });

test("names: safe single segment, untitled has the date", () => {
  assert.equal(cleanName("  My  Film "), "My Film");
  assert.equal(cleanName("../../etc/passwd"), "etc passwd");
  assert.equal(cleanName(".hidden"), "hidden");
  assert.equal(cleanName("a:b*c?.json"), "a b c");
  assert.equal(cleanName(".."), "");
  assert.equal(cleanName("nul"), "nul_");
  assert.equal(cleanName("x".repeat(200)).length, 80);
  assert.equal(untitledName(new Date(2026, 10, 4, 14, 32)), "Untitled 2026-11-04 1432");
  const d = new Date(2026, 10, 4, 9, 5, 7, 12);
  assert.equal(autosaveStamp(d), "20261104-090507-012");
  assert.equal(stampDate("20261104-090507-012.json").getTime(), d.getTime());
});

test("save / open round trip writes the workflow and the manifest", async () => {
  const api = fakeApi();
  let now = 1_000;
  const store = new ProjectStore({ api, now: () => now });
  const res = await store.save("My Film", WF());
  assert.equal(res.path, "workflows/My Film.json");
  assert.ok(api.files.has("workflows/My Film.json") && api.files.has("projects/My Film/project.json"));
  const back = await store.open("My Film");
  assert.deepEqual(back.nodes, WF().nodes);
  assert.equal(projectNameOf(back), "My Film");
  now = 2_000;
  await store.save("My Film", WF());
  const m = await store.manifest("My Film");
  assert.equal(m.saves, 2);
  assert.equal(m.created, 1_000);
  assert.equal(m.saved_at, 2_000);
  await store.save("Other", WF());
  assert.deepEqual((await store.list()).map((p) => p.name), ["Other", "My Film"]);
  await assert.rejects(store.save("..", WF()));
  assert.equal(await store.open("nope"), null);
});

test("an old workflow without a project stamp still opens", async () => {
  const api = fakeApi();
  const old = { nodes: [{ id: 1, type: "SoundstageStage" }], links: [], extra: {} };
  await api.storeUserData("workflows/Old.json", old);
  const store = new ProjectStore({ api });
  assert.deepEqual(await store.open("Old"), old);
  assert.equal(projectNameOf(old), null);
});

test("autosave keeps the newest 20 and restores one", async () => {
  const api = fakeApi();
  let now = new Date(2026, 10, 4, 10, 0, 0).getTime();
  const store = new ProjectStore({ api, now: () => now });
  for (let i = 0; i < 25; i++) {
    const wf = WF();
    wf.nodes[0].properties.ss_ltx.sh_a.steps = i;
    await store.autosave("My Film", wf);
    now += 61_000;
  }
  const list = await store.autosaves("My Film");
  assert.equal(list.length, 20);
  assert.ok(list[0].at > list[19].at, "newest first");
  const newest = await store.readAutosave("My Film", list[0].file);
  assert.equal(newest.nodes[0].properties.ss_ltx.sh_a.steps, 24);
  const oldestKept = await store.readAutosave("My Film", list[19].file);
  assert.equal(oldestKept.nodes[0].properties.ss_ltx.sh_a.steps, 5);
  assert.equal(projectNameOf(newest), "My Film");
  // only files under projects/My Film/autosave/ were touched; refuses odd file names
  assert.equal(await store.readAutosave("My Film", "../project.json"), null);
  assert.equal(await store.readAutosave("My Film", "../../workflows/x.json"), null);
});

test("autosave clock: debounced after a change, at most a minute apart while changing, idle otherwise", () => {
  const c = new AutosaveClock({ every: 60_000, debounce: 4_000 });
  assert.equal(c.due(10_000), false);              // nothing changed
  c.change(10_000);
  assert.equal(c.due(12_000), false);              // still typing
  assert.equal(c.due(14_000), true);
  c.wrote(14_000);
  assert.equal(c.due(100_000), false);
  for (let t = 20_000; t < 74_000; t += 2_000) { c.change(t); assert.equal(c.due(t), false, `t=${t}`); }
  c.change(74_000);
  assert.equal(c.due(74_000), true);               // a minute of non-stop change still autosaves
});

test("signature ignores pan/zoom and the project stamp, sees real changes", () => {
  const a = WF(), b = WF();
  b.extra.ds = { scale: 2, offset: [5, 5] };
  b.extra.ss_project = { name: "X", saved_at: 5 };
  assert.equal(workflowSig(a), workflowSig(b));
  b.nodes[0].properties.ss_ltx.sh_a.steps = 9;
  assert.notEqual(workflowSig(a), workflowSig(b));
});

test("status pill text", () => {
  const now = 100_000;
  assert.equal(statusText({ savedAt: now - 12_000, now }).text, "Saved 12 s ago · Autosave on");
  assert.equal(statusText({ now }).text, "Not saved yet · Autosave on");
  assert.equal(statusText({ savedAt: 1, autosavedAt: now - 40_000, dirty: true, now }).text, "Unsaved changes · autosaved 40 s ago");
  assert.equal(statusText({ savedAt: 1, dirty: true, autosaveOn: false, now }).state, "dirty");
  assert.equal(statusText({ error: "disk full", now }).state, "error");
  assert.equal(ago(0, 3 * 3600_000), "3 h");
});
