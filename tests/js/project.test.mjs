// node --test tests/js/   (Projects: save / open round trip, autosave rotation and restore, the status pill, names; the
// pure half in web/project/store.mjs, against an in-memory stand-in for ComfyUI's userdata API)
import test from "node:test";
import assert from "node:assert/strict";

import {
  ProjectStore, AutosaveClock, cleanName, untitledName, autosaveStamp, stampDate, statusText, workflowSig, projectNameOf, ago,
  projectIdOf, newProjectId, stampWorkflow, PROJECT_ID_RE,
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

// ---------------------------------------------------------------- project id (Ask's memory keys on it)
const man = async (api, n) => JSON.parse(api.files.get(`projects/${n}/project.json`).body);
const wfOn = async (api, n) => JSON.parse(api.files.get(`workflows/${n}.json`).body);

test("project id: p_ + 8 hex, written into project.json and extra.ss_project.id; kept when the workflow carries it", async () => {
  const api = fakeApi();
  const store = new ProjectStore({ api });
  const r1 = await store.save("Film", WF());
  assert.match(r1.id, /^p_[0-9a-f]{8}$/);
  assert.equal((await man(api, "Film")).id, r1.id);
  assert.equal(projectIdOf(await wfOn(api, "Film")), r1.id);
  assert.equal(await store.projectId("Film"), r1.id);
  // re-save the saved workflow (it carries the id): same id
  const r2 = await store.save("Film", r1.workflow);
  assert.equal(r2.id, r1.id);
  // autosave keeps the id in the stamped workflow
  await store.autosave("Film", r2.workflow);
  const [a] = await store.autosaves("Film");
  assert.equal(projectIdOf(await store.readAutosave("Film", a.file)), r1.id);
  // a manifest field can't smuggle in an id
  const r3 = await store.save("Film", r2.workflow, { manifest: { id: "p_deadbeef", title: "x" } });
  assert.equal(r3.id, r1.id);
  assert.equal((await man(api, "Film")).title, "x");
  // Save As to a new name: a new project, a fresh id
  const r4 = await store.save("Film B", r3.workflow);
  assert.notEqual(r4.id, r1.id);
  assert.equal(await store.projectId("Film"), r1.id, "the original keeps its own");
  assert.equal(await store.projectId("nope"), null);
});

test("project id: an old project (no id) gets one on its next save, never on open / list / autosave", async () => {
  const api = fakeApi();
  const store = new ProjectStore({ api });
  // a project saved before ids existed
  const old = { ...WF(), extra: { ss_project: { name: "Old", saved_at: 5 } } };
  await api.storeUserData("workflows/Old.json", old);
  await api.storeUserData("projects/Old/project.json", { format: "soundstage-project", v: 1, name: "Old", created: 1, saved_at: 5, saves: 3 });
  const opened = await store.open("Old");
  assert.equal(projectIdOf(opened), null);
  await store.list();
  await store.autosave("Old", opened);
  assert.equal("id" in (await man(api, "Old")), false, "open / list / autosave write no id");
  assert.equal(projectIdOf(await wfOn(api, "Old")), null);
  const [a] = await store.autosaves("Old");
  assert.equal(projectIdOf(await store.readAutosave("Old", a.file)), null);
  const r = await store.save("Old", opened);
  assert.match(r.id, PROJECT_ID_RE);
  assert.equal((await man(api, "Old")).id, r.id);
  assert.equal((await man(api, "Old")).created, 1, "the rest of the manifest history stays");
  assert.equal((await man(api, "Old")).saves, 4);
});

test("project id: a leftover projects/<name>/ folder (workflow deleted from the sidebar) does not hand its id to a new workflow", async () => {
  const api = fakeApi();
  const store = new ProjectStore({ api });
  const r1 = await store.save("Reused", WF());
  await api.deleteUserData("workflows/Reused.json");            // deleted from ComfyUI's sidebar; the folder stays
  const fresh = WF();                                            // a different workflow, saved under the same name
  const r2 = await store.save("Reused", fresh);
  assert.notEqual(r2.id, r1.id);
  assert.equal((await man(api, "Reused")).id, r2.id);
  // a workflow carrying ANOTHER project's id saved over this one: also fresh
  const other = await store.save("Other", WF());
  const r3 = await store.save("Reused", other.workflow);
  assert.notEqual(r3.id, other.id);
  assert.notEqual(r3.id, r2.id);
});

test("project id helpers: shape, malformed ids ignored, stampWorkflow keeps or drops the id", () => {
  const ids = new Set(Array.from({ length: 300 }, () => newProjectId()));
  assert.equal(ids.size, 300);
  for (const i of ids) assert.match(i, /^p_[0-9a-f]{8}$/);
  assert.equal(projectIdOf({ extra: { ss_project: { id: "p_XYZ" } } }), null);
  assert.equal(projectIdOf(null), null);
  const w = { extra: { ss_project: { name: "A", id: "p_0a1b2c3d" } } };
  assert.equal(projectIdOf(stampWorkflow(w, "A", 1)), "p_0a1b2c3d");
  assert.equal(projectIdOf(stampWorkflow(w, "A", 1, null)), null);
  assert.equal(workflowSig(stampWorkflow(w, "A", 1)), workflowSig(stampWorkflow(w, "A", 2, "p_11111111")), "an id is not a change");
});

test("ProjectController.projectId(): the open workflow's id, kept through Save; null before the first save", async () => {
  globalThis.window ||= { addEventListener() {} };
  const { ProjectController } = await import("../../web/project/projectbar.mjs");
  const ufs = fakeApi();
  const app = { graph: { ...WF(), extra: { ss_project: { name: "Live" } } }, extensionManager: {} };
  app.graph.serialize = () => { const { serialize, ...g } = app.graph; return JSON.parse(JSON.stringify(g)); };   // eslint-disable-line no-unused-vars
  const ctl = new ProjectController({ app, api: ufs });
  clearInterval(ctl._timer);
  ctl.render = () => {}; ctl.say = () => {};
  try {
    assert.equal(ctl.projectId(), null, "never saved: no id, and opening wrote none");
    await ctl.tick();
    await ctl.save();
    const id = ctl.projectId();
    assert.match(id, PROJECT_ID_RE);
    assert.equal((await man(ufs, "Live")).id, id);
    await ctl.save();
    assert.equal(ctl.projectId(), id, "the graph keeps the id, so the next save keeps it");
    ctl._ensureName(ctl._cur());
    assert.equal(ctl.projectId(), id, "naming / autosave stamping does not drop it");
  } finally { clearInterval(ctl._timer); }
});
