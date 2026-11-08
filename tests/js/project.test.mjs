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

test("project id: only a workflow carrying the same id keeps it; a graph with no id always gets a fresh one", async () => {
  const api = fakeApi();
  const store = new ProjectStore({ api });
  const mine = await store.save("Scene 1", WF());
  assert.equal((await store.save("Scene 1", mine.workflow)).id, mine.id, "the project's own graph (same id) keeps it");
  // someone else's unrelated old 'Scene 1' (pre-id, same name) saved over mine: it does not take my id
  const foreign = { ...WF(), extra: { ss_project: { name: "Scene 1", saved_at: 5 } } };
  const r = await store.save("Scene 1", foreign);
  assert.notEqual(r.id, mine.id, "a foreign id-less graph with the same name gets a fresh id");
  assert.equal((await man(api, "Scene 1")).id, r.id);
  assert.equal(projectIdOf(await wfOn(api, "Scene 1")), r.id);
  // also fresh: an unnamed graph, another-named graph, a leftover folder
  const k = r.id;
  assert.notEqual((await store.save("Scene 1", WF())).id, k);
  const k2 = (await man(api, "Scene 1")).id;
  assert.notEqual((await store.save("Scene 1", { ...WF(), extra: { ss_project: { name: "Elsewhere" } } })).id, k2);
  // known cost of the rule: a second tab opened before the first id'd save gets a fresh id when it saves
  const old = { ...WF(), extra: { ss_project: { name: "Old", saved_at: 5 } } };
  await api.storeUserData("workflows/Old.json", old);
  await api.storeUserData("projects/Old/project.json", { format: "soundstage-project", v: 1, name: "Old", created: 1, saved_at: 5, saves: 3 });
  const tabA = await store.open("Old"), tabB = await store.open("Old");
  const a1 = await store.save("Old", tabA);
  const b1 = await store.save("Old", tabB);
  assert.notEqual(b1.id, a1.id);
  assert.equal((await store.save("Old", b1.workflow)).id, b1.id, "and from then on that graph keeps its own");
});

test("confirmProjectId / projectId(): an id no saved project.json confirms is not reported", async () => {
  const api = fakeApi();
  const store = new ProjectStore({ api });
  const r = await store.save("Film", WF());
  assert.deepEqual(await store.confirmProjectId(r.workflow), { id: r.id, name: "Film", graph_id: r.id, manifest_id: r.id, confirmed: true });
  // an exported / collected copy opened where its project.json is not, or a tab left open after a library rename
  const moved = stampWorkflow(r.workflow, "Gone", 1);
  assert.deepEqual(await store.confirmProjectId(moved), { id: null, name: "Gone", graph_id: r.id, manifest_id: null, confirmed: false });
  // the name was reused by another project (another id in its project.json)
  await api.storeUserData("projects/Film/project.json", { format: "soundstage-project", v: 1, id: "p_99999999", name: "Film" });
  assert.equal((await store.confirmProjectId(r.workflow)).confirmed, false);
  assert.equal((await store.confirmProjectId(WF())).id, null);

  // the controller: projectId() is null until confirmed, and drops back to null when project.json stops agreeing
  globalThis.window ||= { addEventListener() {} };
  const { ProjectController } = await import("../../web/project/projectbar.mjs");
  const ufs = fakeApi();
  const saved = await new ProjectStore({ api: ufs }).save("Live", WF());
  const app = { graph: JSON.parse(JSON.stringify(saved.workflow)), extensionManager: {} };
  app.graph.serialize = () => { const { serialize, ...g } = app.graph; return JSON.parse(JSON.stringify(g)); };   // eslint-disable-line no-unused-vars
  const ctl = new ProjectController({ app, api: ufs });
  clearInterval(ctl._timer);
  ctl.render = () => {}; ctl.say = () => {};
  try {
    assert.equal(ctl.projectId(), null, "a dragged-in / opened graph: not confirmed before the check");
    await ctl.tick();
    assert.equal(ctl.projectId(), saved.id, "confirmed against projects/Live/project.json");
    assert.deepEqual(ctl.current(), { id: saved.id, name: "Live" });
    // renamed in the library while this tab stayed open: project.json moved away
    ufs.files.delete("projects/Live/project.json");
    assert.equal((await ctl.project()).confirmed, false);
    assert.equal(ctl.projectId(), null);
    assert.equal(ctl.current().id, saved.id, "current() still says what the graph carries (Forget's scope)");
  } finally { clearInterval(ctl._timer); }
});

test("open collected on the machine that still has the live project: no id is confirmed, and Save asks before replacing it", async () => {
  globalThis.window ||= { addEventListener() {} };
  const { ProjectController } = await import("../../web/project/projectbar.mjs");
  const ufs = fakeApi();
  const live = await new ProjectStore({ api: ufs }).save("Heist", WF());
  const liveBody = ufs.files.get("workflows/Heist.json").body;
  // the collected copy carries the live project's id and name, relinked to output/soundstage_projects/Heist/
  const copy = JSON.parse(JSON.stringify(live.workflow));
  copy.nodes[0].widgets_values = ['{"relinked":"output/soundstage_projects/Heist"}'];
  ufs.fetchApi = async (path) => ({ ok: true, json: async () => (path.endsWith("open_collected") ? { name: "Heist", folder: "Heist", workflow: copy } : {}) });
  const asked = [];
  let replace = false;
  const app = { graph: { ...WF(), extra: {} }, extensionManager: { dialog: {
    prompt: async ({ title, defaultValue }) => { asked.push(title); return defaultValue; },
    confirm: async ({ title }) => { asked.push(title); return replace; },
  } } };
  app.graph.serialize = () => { const { serialize, ...g } = app.graph; return JSON.parse(JSON.stringify(g)); };   // eslint-disable-line no-unused-vars
  app.loadGraphData = async (wf) => { const ser = app.graph.serialize; app.graph = { ...JSON.parse(JSON.stringify(wf)), serialize: ser }; };
  const ctl = new ProjectController({ app, api: ufs });
  clearInterval(ctl._timer);
  ctl.render = () => {}; ctl.say = () => {};
  try {
    await ctl.openCollected("Heist");
    assert.equal(projectIdOf(app.graph.serialize()), null, "the copy drops the carried id");
    await ctl.tick();
    assert.equal(ctl.projectId(), null, "never confirmed as the live project");
    assert.equal((await ctl.project()).confirmed, false);
    await ctl.save();                                             // plain Save: asks a name, then to replace, declined
    assert.deepEqual(asked, ["Save project", "Replace project?"]);
    assert.equal(ufs.files.get("workflows/Heist.json").body, liveBody, "the live project is untouched");
    assert.equal((await man(ufs, "Heist")).id, live.id);
    replace = true;                                               // the user says yes: a replace with a fresh id
    await ctl.save();
    assert.notEqual((await man(ufs, "Heist")).id, live.id);
    assert.equal(ctl.projectId(), (await man(ufs, "Heist")).id);
    asked.length = 0;
    await ctl.save();                                             // saved here now: an ordinary Save, no prompt
    assert.deepEqual(asked, []);
  } finally { clearInterval(ctl._timer); }
});

/** fakeApi with a random delay before each read and write lands (two tabs racing over ComfyUI's userdata API). */
function slowApi(rand) {
  const api = fakeApi();
  const wait = () => new Promise((r) => setTimeout(r, Math.floor(rand() * 4)));
  const { storeUserData, getUserData } = api;
  api.storeUserData = async (...a) => { await wait(); return storeUserData(...a); };
  api.getUserData = async (...a) => { await wait(); return getUserData(...a); };
  return api;
}

test("two tabs saving one project at once: workflows/X.json and project.json end with the same id, and only that id is confirmed", async () => {
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  let unconfirmed = 0, stale = 0;
  for (let trial = 0; trial < 200; trial++) {
    const api = slowApi(rand);
    const first = await new ProjectStore({ api }).save("X", WF());
    const tabA = new ProjectStore({ api }), tabB = new ProjectStore({ api });
    // A re-saves the project's own graph, B a graph with no id (a second tab opened before the first id'd save)
    const [a, b] = await Promise.all([tabA.save("X", first.workflow), tabB.save("X", WF())]);
    const wid = projectIdOf(await wfOn(api, "X")), mid = (await man(api, "X")).id;
    assert.equal(wid, mid, `trial ${trial}: the two files agree`);
    assert.ok([a.id, b.id].includes(wid), `trial ${trial}: the id on disk is one of the two saves'`);
    for (const r of [a, b]) {
      if (r.confirmed) assert.equal(r.disk_id, r.id);
      // known window: a save that settled before the other tab's write landed says confirmed although the disk has
      // moved on since; the controller's 15 s check (project()) drops it. Counted, not hidden.
      if (r.confirmed && r.id !== wid) stale++;
      if (!r.confirmed) unconfirmed++;
    }
    assert.equal((await new ProjectStore({ api }).confirmProjectId(wid === a.id ? a.workflow : b.workflow)).confirmed, true);
  }
  assert.ok(unconfirmed + stale > 0, "the race really happened in some trials");
  console.log(`# two-tab race: ${unconfirmed} saves told unconfirmed, ${stale} confirmed then overtaken, of 400`);
});

test("two saves from one page are run one after the other", async () => {
  const api = slowApi(Math.random);
  const store = new ProjectStore({ api });
  const r1 = await store.save("Y", WF());
  const [a, b] = await Promise.all([store.save("Y", r1.workflow), store.save("Y", r1.workflow)]);
  assert.equal(a.id, r1.id);
  assert.equal(b.id, r1.id);
  assert.ok(a.confirmed && b.confirmed);
  assert.equal((await man(api, "Y")).saves, 3);
});

// ------------------------------------------------------------------ copies made with ComfyUI's own tools (review finding 1)
test("a copy opened from another path (ComfyUI Duplicate / Save As, a dragged-in .json or render) never confirms or silently replaces the project", async () => {
  const api = fakeApi();
  const store = new ProjectStore({ api });
  const a = await store.save("Alpha", WF());
  const aliveBody = api.files.get("workflows/Alpha.json").body;
  // ComfyUI's Workflow → Duplicate / Save As copies the file verbatim: same extra.ss_project name and id
  const copy = JSON.parse(aliveBody);
  copy.nodes = [{ id: 99, type: "SoundstageStage", widgets_values: ['{"different":true}'] }];
  const c = await store.confirmProjectId(copy, { path: "workflows/Alpha copy.json" });
  assert.equal(c.confirmed, false, "a copy at another path is not the project");
  assert.equal(c.id, null);
  assert.equal(c.copy, true);
  assert.equal((await store.confirmProjectId(copy, { path: "workflows/Alpha.json" })).confirmed, true, "the project's own path still confirms");
  await assert.rejects(store.save("Alpha", copy, { from: "workflows/Alpha copy.json" }), (e) => e.code === "exists");
  assert.equal(api.files.get("workflows/Alpha.json").body, aliveBody, "the project is untouched");
  const r = await store.save("Alpha", copy, { from: "workflows/Alpha copy.json", replace: true });
  assert.notEqual(r.id, a.id, "a copy that replaces the project gets a fresh id");
  // a copy saved under a new name is simply a new project
  const n = await store.save("Alpha 2", copy, { from: "workflows/Alpha copy.json" });
  assert.ok(PROJECT_ID_RE.test(n.id) && n.id !== a.id && n.confirmed);
});

test("the pill: a ComfyUI Duplicate tab of a project is a copy: no id, Save asks a name and to replace, autosaves go to '<name> (copy)'", async () => {
  globalThis.window ||= { addEventListener() {} };
  const { ProjectController } = await import("../../web/project/projectbar.mjs");
  const ufs = fakeApi();
  const live = await new ProjectStore({ api: ufs }).save("Alpha", WF());
  for (let k = 0; k < 3; k++) await new ProjectStore({ api: ufs, now: () => 1_700_000_000_000 + k * 1000 }).autosave("Alpha", live.workflow);
  const liveBody = ufs.files.get("workflows/Alpha.json").body;
  const ownAutos = [...ufs.files.keys()].filter((p) => p.startsWith("projects/Alpha/autosave/")).sort();
  const active = { path: "workflows/Alpha copy.json", isTemporary: false };
  const asked = [];
  let replace = false;
  const copy = JSON.parse(liveBody);
  copy.nodes[0].widgets_values = ['{"edited":"in the copy"}'];
  const app = { graph: { ...copy }, extensionManager: { workflow: { activeWorkflow: active }, dialog: {
    prompt: async ({ title, defaultValue }) => { asked.push(title); return defaultValue; },
    confirm: async ({ title }) => { asked.push(title); return replace; },
  } } };
  app.graph.serialize = () => { const { serialize, ...g } = app.graph; return JSON.parse(JSON.stringify(g)); };   // eslint-disable-line no-unused-vars
  const ctl = new ProjectController({ app, api: ufs });
  clearInterval(ctl._timer);
  ctl.render = () => {}; ctl.say = () => {};
  try {
    await ctl.tick();
    assert.equal(ctl.projectId(), null, "the copy is never confirmed as Alpha");
    assert.equal((await ctl.project()).confirmed, false);
    assert.equal(ctl.current().copy, true);
    for (let k = 0; k < 25; k++) await ctl.autosaveNow();         // more than AUTOSAVE_KEEP
    assert.deepEqual([...ufs.files.keys()].filter((p) => p.startsWith("projects/Alpha/autosave/")).sort(), ownAutos,
      "the copy's autosaves never push the project's own out");
    assert.ok([...ufs.files.keys()].some((p) => p.startsWith("projects/Alpha (copy)/autosave/")));
    const auto = JSON.parse([...ufs.files.entries()].find(([p]) => p.startsWith("projects/Alpha (copy)/autosave/"))[1].body);
    assert.equal(projectIdOf(auto.workflow), null, "a copy's autosave carries no id");
    await ctl.save();                                               // plain Save: asks, declined
    assert.deepEqual(asked, ["Save project", "Replace project?"]);
    assert.equal(ufs.files.get("workflows/Alpha.json").body, liveBody, "Alpha is untouched");
    replace = true;
    await ctl.save();
    const id2 = (await man(ufs, "Alpha")).id;
    assert.notEqual(id2, live.id, "replaced with a fresh id");
    assert.equal(ctl.projectId(), id2, "this tab is the project now");
    asked.length = 0;
    await ctl.save();                                               // bound: an ordinary Save from now on
    assert.deepEqual(asked, []);
    // the project's own tab (path workflows/Alpha.json) is not a copy; a temporary (dragged-in) one at that path is
    active.path = "workflows/Alpha.json";
    await ctl.tick();                                               // a new tab key: not bound by this controller
    assert.equal(ctl._isCopy(), false);
    active.isTemporary = true;
    assert.equal(ctl._isCopy(), true, "a dragged-in Alpha.json export opens as a temporary workflow");
  } finally { clearInterval(ctl._timer); }
});

// ------------------------------------------------------------------ two tabs, alternating saves (review finding 2)
test("two tabs (two pages) saving one project in turn settle on one id instead of a new id per save", async () => {
  const api = fakeApi();
  let now = 5_000;
  // an old pre-id project open in two pages
  await api.storeUserData("workflows/Old.json", { nodes: [], extra: { ss_project: { name: "Old" } } });
  await api.storeUserData("projects/Old/project.json", { format: "soundstage-project", v: 1, name: "Old" });
  const t1 = new ProjectStore({ api, now: () => (now += 10) }), t2 = new ProjectStore({ api, now: () => (now += 10) });
  let g1 = await t1.open("Old"), g2 = await t2.open("Old");
  const ids = [];
  for (let i = 0; i < 4; i++) {
    let r = await t1.save("Old", g1); g1 = r.workflow; ids.push(r.id); assert.ok(r.confirmed);
    r = await t2.save("Old", g2); g2 = r.workflow; ids.push(r.id); assert.ok(r.confirmed);
  }
  // t1 mints A, t2 (a graph with no id) mints B, then t1 adopts B: from then on one id
  assert.equal(new Set(ids).size, 2, `ids: ${ids.join(" ")}`);
  assert.ok(ids.slice(1).every((x) => x === ids[1]));
  assert.equal((await man(api, "Old")).id, ids[1]);
  // a different page's graph carrying an id it never wrote is not adopted (the spec rule still holds)
  const t3 = new ProjectStore({ api });
  const foreign = stampWorkflow(WF(), "Old", 1, "p_12345678");
  assert.notEqual((await t3.save("Old", foreign)).id, ids[1]);
  // a project replaced after a Trash (new created stamp) is not adopted into either
  api.files.delete("projects/Old/project.json");
  const fresh = await new ProjectStore({ api }).save("Old", WF());
  assert.notEqual((await t1.save("Old", g1)).id, fresh.id, "t1's old id belongs to the trashed project");
});

// ------------------------------------------------------------------ round 5, finding 1: adopt never crosses content
test("Save As Q under the name P + Replace: a tab still holding P's old id never adopts the id minted for Q", async () => {
  for (const variant of ["Q saved before (carries its own id)", "Q never saved (no name, no id), replace", "Q named P, no id, replace"]) {
    const api = fakeApi();
    let now = 10_000;
    const pageA = new ProjectStore({ api, now: () => (now += 10) }), pageB = new ProjectStore({ api, now: () => (now += 10) });
    const a = await pageA.save("P", WF());                                   // page A: P, id X
    const createdP = (await man(api, "P")).created;
    const q = WF(); q.nodes[0].widgets_values = ['{"graph":"Q"}'];
    const qwf = variant.startsWith("Q saved") ? stampWorkflow(q, "Q", 1, "p_0a0b0c0d")
      : variant.startsWith("Q never") ? q : stampWorkflow(q, "P", 1, null);
    // page B: Save As P, Replace (the pill passes replace whenever "Replace project?" was confirmed; the first variant
    // is also caught without it, by the other id / other name it carries)
    const b = await pageB.save("P", qwf, variant.startsWith("Q saved") ? {} : { replace: true });
    assert.notEqual(b.id, a.id, variant);
    assert.notEqual((await man(api, "P")).created, createdP, `${variant}: other content starts a new project (created reset)`);
    const again = await pageA.save("P", a.workflow);                          // page A saves its P graph carrying X
    assert.notEqual(again.id, b.id, `${variant}: A's P graph must not take Q's id`);
    assert.notEqual(again.id, a.id, `${variant}: and X is not kept either (project.json held another id)`);
  }
});

test("the pill: page B Save As Q under P and confirms Replace; page A's next Save of P does not take Q's id", async () => {
  globalThis.window ||= { addEventListener() {} };
  const { ProjectController } = await import("../../web/project/projectbar.mjs");
  const ufs = fakeApi();
  const mk = (graph, path, answer) => {
    const app = { graph: { ...graph }, extensionManager: { workflow: { activeWorkflow: { path, isTemporary: false } }, dialog: {
      prompt: async () => answer, confirm: async () => true } } };
    app.graph.serialize = () => { const { serialize, ...g } = app.graph; return JSON.parse(JSON.stringify(g)); };   // eslint-disable-line no-unused-vars
    const ctl = new ProjectController({ app, api: ufs });
    clearInterval(ctl._timer); ctl.render = () => {}; ctl.say = () => {};
    return ctl;
  };
  const p0 = await new ProjectStore({ api: ufs }).save("P", WF());
  const q = WF(); q.nodes[0].widgets_values = ['{"graph":"Q"}'];
  const q0 = await new ProjectStore({ api: ufs }).save("Q", q);
  const A = mk(JSON.parse(ufs.files.get("workflows/P.json").body), "workflows/P.json", "P");
  const B = mk(q0.workflow, "workflows/Q.json", "P");
  await A.tick(); await B.tick();
  await A.save();
  const x = (await man(ufs, "P")).id;
  assert.equal(x, p0.id);
  await B.save({ as: true });                                         // Save As "P", Replace: yes
  const f = (await man(ufs, "P")).id;
  assert.notEqual(f, x);
  assert.equal(JSON.parse(ufs.files.get("workflows/P.json").body).nodes[0].widgets_values[0], '{"graph":"Q"}');
  await A.save();                                                     // page A still holds P's graph carrying X
  assert.notEqual((await man(ufs, "P")).id, f, "A's P graph must not be filed under the id minted for Q");
});

// ------------------------------------------------------------------ round 5, finding 2: tab state never outlives its tab
test("the pill: a project tab opened from the pill, closed, then an older Alpha.json dragged in at the same path is a copy", async () => {
  globalThis.window ||= { addEventListener() {} };
  const { ProjectController } = await import("../../web/project/projectbar.mjs");
  const ufs = fakeApi();
  const old = await new ProjectStore({ api: ufs }).save("Alpha", WF());          // an export made back then
  const exported = JSON.parse(JSON.stringify(old.workflow));
  const live = await new ProjectStore({ api: ufs }).save("Alpha", { ...WF(), nodes: [{ ...WF().nodes[0], widgets_values: ['{"v":"live"}'] }] }, { replace: true });
  const liveBody = ufs.files.get("workflows/Alpha.json").body;
  const asked = [];
  for (const listsOpen of [false, true]) {
    asked.length = 0;
    const wfs = { activeWorkflow: null, ...(listsOpen ? { openWorkflows: [] } : {}) };
    const app = { graph: {}, extensionManager: { workflow: wfs, dialog: {
      prompt: async ({ title }) => { asked.push(title); return "Alpha"; },
      confirm: async ({ title }) => { asked.push(title); return false; } } } };
    app.graph.serialize = () => { const { serialize, ...g } = app.graph; return JSON.parse(JSON.stringify(g)); };   // eslint-disable-line no-unused-vars
    const openTab = (graph) => {                                                // ComfyUI: a new temporary tab at workflows/Alpha.json
      const w = { path: "workflows/Alpha.json", isTemporary: true };
      if (listsOpen) wfs.openWorkflows = [...wfs.openWorkflows.filter((x) => x !== wfs.activeWorkflow), w];
      wfs.activeWorkflow = w;
      const ser = app.graph.serialize;
      app.graph = { ...JSON.parse(JSON.stringify(graph)), serialize: ser };
    };
    app.loadGraphData = async (g) => openTab(g);
    const ctl = new ProjectController({ app, api: ufs });
    clearInterval(ctl._timer); ctl.render = () => {}; ctl.say = () => {};
    await ctl.open("Alpha");                                                    // bound: opened here as the project
    assert.equal(ctl._isCopy(), false);
    assert.equal(ctl.projectId(), live.id);
    openTab(exported);                                                          // closed; the old export dragged in
    assert.equal(ctl._isCopy(), true, `listsOpen=${listsOpen}: before any tick`);
    await ctl.tick();
    assert.equal(ctl._isCopy(), true, `listsOpen=${listsOpen}: the dragged-in export inherits nothing`);
    assert.equal(ctl.projectId(), null);
    await ctl.save();                                                           // asks; Replace declined
    assert.deepEqual(asked, ["Save project", "Replace project?"]);
    assert.equal(ufs.files.get("workflows/Alpha.json").body, liveBody, "the live project is untouched");
    assert.equal((await man(ufs, "Alpha")).id, live.id, "and keeps its id");
  }
});

// ------------------------------------------------------------------ round 6, fix 1: New project under an existing name
test("the pill: New project with an existing project's name asks 'Replace project?'; No leaves it, Yes forks it (page A never adopts the template's id)", async () => {
  globalThis.window ||= { addEventListener() {} };
  const { ProjectController } = await import("../../web/project/projectbar.mjs");
  const ufs = fakeApi();
  const tpl = WF(); tpl.nodes[0].widgets_values = ['{"graph":"template"}'];
  const mk = (graph, path, { answer = "P", yes = true, asked = [] } = {}) => {
    const wfs = { activeWorkflow: { path, isTemporary: false } };
    const app = { graph: { ...graph }, extensionManager: { workflow: wfs, dialog: {
      prompt: async ({ title }) => { asked.push(title); return answer; }, confirm: async ({ title }) => { asked.push(title); return yes; } } } };
    app.graph.serialize = () => { const { serialize, ...g } = app.graph; return JSON.parse(JSON.stringify(g)); };   // eslint-disable-line no-unused-vars
    app.loadGraphData = async (g, _a, _b, n) => {
      wfs.activeWorkflow = { path: `workflows/${n}.json`, isTemporary: true };
      const ser = app.graph.serialize; app.graph = { ...JSON.parse(JSON.stringify(g)), serialize: ser };
    };
    const api = { ...ufs, fetchApi: async (u) => (u === "/soundstage/project/template" ? { ok: true, json: async () => JSON.parse(JSON.stringify(tpl)) } : { ok: false }) };
    const ctl = new ProjectController({ app, api });
    clearInterval(ctl._timer); ctl.render = () => {}; ctl.say = () => {};
    return ctl;
  };
  const p0 = await new ProjectStore({ api: ufs }).save("P", WF());
  const A = mk(JSON.parse(ufs.files.get("workflows/P.json").body), "workflows/P.json");
  await A.tick(); await A.save();
  const x = (await man(ufs, "P")).id, created0 = (await man(ufs, "P")).created, body0 = ufs.files.get("workflows/P.json").body;
  assert.equal(x, p0.id);

  // page B: New project "P", Replace declined -> nothing written
  const askedNo = [];
  const Bno = mk({ nodes: [], links: [], extra: {} }, "workflows/Unsaved.json", { yes: false, asked: askedNo });
  await Bno.newProject();
  assert.deepEqual(askedNo, ["New project", "Replace project?"]);
  assert.equal(ufs.files.get("workflows/P.json").body, body0, "declined: P is untouched");
  assert.equal((await man(ufs, "P")).id, x);

  // page B: New project "P", Replace confirmed -> the template replaces P with a fresh id and a new `created`
  const askedYes = [];
  const B = mk({ nodes: [], links: [], extra: {} }, "workflows/Unsaved.json", { asked: askedYes });
  await B.newProject();
  assert.deepEqual(askedYes, ["New project", "Replace project?"]);
  const m = await man(ufs, "P");
  assert.notEqual(m.id, x);
  assert.notEqual(m.created, created0, "a replace is a fork: created moves");
  assert.equal(JSON.parse(ufs.files.get("workflows/P.json").body).nodes[0].widgets_values[0], '{"graph":"template"}');
  await A.save();                                                     // page A still holds the old P graph carrying x
  assert.notEqual((await man(ufs, "P")).id, m.id, "A's old P graph never takes the id made for the template");
});
