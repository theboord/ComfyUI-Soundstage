// The project pill in the App's top row: the project's name, "Saved 12 s ago · Autosave on", and a menu with
// Save / Save As / Open / Open recent / New / Restore autosave / Collect project / Open collected project.
// The pure half (paths, names, rotation, the autosave clock, the pill text) is web/project/store.mjs. docs/projects.md
//
//   import { mountProjectBar } from "./project/projectbar.mjs";
//   mountProjectBar({ app, api, row: tabs, before: guideBtn, host: { cutFiles, timeline, scriptFull, deliverView, say } });
//
// One controller per page (window.__ssProject): it watches whichever workflow is open, every few seconds, and only
// autosaves a workflow that has a Soundstage stage in it. Each stage widget gets its own pill bound to it.
import { openMenu } from "../ui/popover.mjs";
import { icon } from "../ui/icons.mjs";
import { openHome } from "./home.mjs";
import { ProjectStore, AutosaveClock, cleanName, untitledName, statusText, workflowSig, projectNameOf, projectIdOf, stampWorkflow, ago } from "./store.mjs";

const TICK_MS = 3_000;
const AUTOSAVE_PREF = "ss_project_autosave";
const CSS = `
.ss-projpill { display:inline-flex; align-items:center; gap:6px; max-width:340px; margin-left:6px; white-space:nowrap; }
.ss-projpill .nm { font-weight:650; overflow:hidden; text-overflow:ellipsis; max-width:150px; }
.ss-projpill .st { opacity:.72; font-size:11.5px; overflow:hidden; text-overflow:ellipsis; }
.ss-projpill[data-state="dirty"] .st, .ss-projpill[data-state="new"] .st { color:#f2c94c; opacity:.95; }
.ss-projpill[data-state="error"] .st { color:#ff6b6b; opacity:1; }
.ss-projcard .row { display:flex; gap:8px; flex-wrap:wrap; }
`;

const readPref = () => { try { return localStorage.getItem(AUTOSAVE_PREF) !== "0"; } catch { return true; } };
const writePref = (on) => { try { localStorage.setItem(AUTOSAVE_PREF, on ? "1" : "0"); } catch { /* storage blocked */ } };

async function askName(app, title, value = "") {
  try {
    const d = app?.extensionManager?.dialog;
    if (d?.prompt) {
      const v = await d.prompt({ title, message: "Project name", defaultValue: value });
      return v == null ? null : cleanName(v);
    }
  } catch { /* fall through to the browser prompt */ }
  const v = window.prompt(`${title}\nProject name:`, value);
  return v == null ? null : cleanName(v);
}

async function confirmBox(app, title, message) {
  try {
    const d = app?.extensionManager?.dialog;
    if (d?.confirm) return !!(await d.confirm({ title, message }));
  } catch { /* fall through */ }
  return window.confirm(`${title}\n\n${message}`);
}

/** The page-wide project controller. */
export class ProjectController {
  constructor({ app, api }) {
    this.app = app;
    this.api = api;
    this.store = new ProjectStore({ api });
    this.autosaveOn = readPref();
    this.tabs = new Map();       // workflow tab key -> { name, savedAt, savedSig, autosavedAt, sig, clock, error }
    this.pills = new Set();
    this.hosts = new Set();
    this.busy = false;
    this._timer = setInterval(() => this.tick().catch(() => {}), TICK_MS);
    window.addEventListener("beforeunload", (e) => {
      const t = this._cur();
      if (t && t.isSoundstage && t.sig && t.sig !== t.savedSig) {
        this.autosaveNow().catch(() => {});     // best effort: the tab may close before it lands
        e.preventDefault();
        e.returnValue = "";
      }
    });
  }

  _key() { return this.app.extensionManager?.workflow?.activeWorkflow?.path || "wf"; }

  /**
   * Is the open workflow a COPY of its project rather than the project itself? A copy made with ComfyUI's own
   * Duplicate or Save As, an exported .json or a render dragged in keeps extra.ss_project (the original's name and
   * id), but it is open from another path than workflows/<name>.json (or is a temporary, never-saved workflow). A copy
   * is treated like an opened collected project: no id is confirmed, its first Save asks for a name and asks before
   * replacing, and it gets a fresh id. A tab this controller opened or saved as the project (t.boundName) is not a
   * copy, whatever path ComfyUI gave it. Unknown host (no workflow store): never a copy.
   */
  _isCopy(t = this._cur(), wf = this.serialize()) {
    if (t?.collected) return true;
    const w = this.app.extensionManager?.workflow?.activeWorkflow;
    const name = projectNameOf(wf);
    if (!w || !name || (t && t.boundName === name)) return false;
    return String(w.path || "") !== ProjectStore.workflowPath(name) || w.isTemporary === true;
  }

  /** The project name autosaves of the open tab go under: a copy's go under "<name> (copy)", so they never push the
   *  project's own autosaves out of projects/<name>/autosave/. */
  _autoName(t = this._cur(), wf = this.serialize()) {
    const n = t?.name;
    return n && this._isCopy(t, wf) ? cleanName(`${n} (copy)`) : n;
  }

  /**
   * The open workflow's project id ("p_" + 8 hex), or null. Only an id CONFIRMED against the saved project.json of the
   * same name (store.confirmProjectId): a Save, an Open, or the check tick() repeats every 15 s / on a name or id
   * change. null: not saved yet, saved before ids existed (its next Save writes one; opening never does), or the graph
   * carries an id its project.json does not (renamed in the library, a collected / exported copy, a reused name), or
   * the tab is a copy (_isCopy: ComfyUI's Duplicate / Save As, a dragged-in .json or render).
   * Sync and read-only. For a fresh answer: await window.__ssProject.project(). docs/projects.md "Project id".
   */
  projectId() {
    const wf = this.serialize(), t = this._cur(), id = projectIdOf(wf);
    return id && t?.confirmedId === id && t.confirmedName === projectNameOf(wf) ? id : null;
  }

  /** Read project.json now: {id (confirmed or null), name, graph_id, manifest_id, confirmed}; refreshes projectId(). */
  async project() {
    const wf = this.serialize();
    const r = await this.store.confirmProjectId(wf, { copy: this._isCopy(this._cur(), wf) });
    const t = this._cur();
    if (t) { t.confirmedId = r.confirmed ? r.id : null; t.confirmedName = r.name; t.checkKey = `${r.name}|${r.graph_id}`; t.checkedAt = Date.now(); }
    return r;
  }

  /** {id, name} of the open workflow as it says (extra.ss_project, unconfirmed): which project's copies Forget cleans. */
  current() {
    const wf = this.serialize();
    return { id: projectIdOf(wf), name: projectNameOf(wf) || this._cur()?.name || null, ...(this._isCopy(this._cur(), wf) ? { copy: true } : {}) };
  }
  _cur() { return this.tabs.get(this._key()); }

  serialize() {
    try { return this.app.graph?.serialize?.() || null; } catch { return null; }
  }

  /** Look at the open workflow: note changes, autosave when due, refresh the pills. */
  async tick() {
    const wf = this.serialize();
    const key = this._key();
    let t = this.tabs.get(key);
    if (!t) {
      t = { name: projectNameOf(wf), savedAt: null, savedSig: null, autosavedAt: null, sig: null, clock: new AutosaveClock(), error: null };
      if (t.name) { t.savedAt = wf?.extra?.ss_project?.saved_at || null; t.savedSig = t.savedAt ? workflowSig(wf) : null; }
      this.tabs.set(key, t);
    }
    if (wf) {
      const name = projectNameOf(wf);
      if (name && name !== t.name) t.name = name;
      const has = (ns) => (ns || []).some((n) => n?.type === "SoundstageStage");
      t.isSoundstage = has(wf.nodes) || (wf.definitions?.subgraphs || []).some((g) => has(g.nodes));
      const sig = workflowSig(wf);
      const now = Date.now();
      if (t.sig !== null && sig !== t.sig) t.clock.change(now);
      t.sig = sig;
      if (this.autosaveOn && t.isSoundstage && !this.busy && t.clock.due(now)) await this.autosaveNow(wf);
      // keep projectId()'s confirmation current: on a name / id change, and every 15 s (a rename in the library)
      if (t.checkKey !== `${name}|${projectIdOf(wf)}` || now - (t.checkedAt || 0) > 15_000) { try { await this.project(); } catch { /* next tick */ } }
    }
    this.render();
  }

  /** Make sure the open workflow has a project name (an unnamed one becomes "Untitled <date>"). */
  _ensureName(t) {
    if (t.name) return t.name;
    t.name = untitledName();
    try { const ex = this.app.graph.extra || {}; this.app.graph.extra = { ...ex, ss_project: { ...(ex.ss_project || {}), name: t.name } }; } catch { /* */ }
    return t.name;
  }

  async autosaveNow(wf = this.serialize()) {
    const t = this._cur();
    if (!t || !wf) return;
    this.busy = true;
    try {
      this._ensureName(t);
      const copy = this._isCopy(t, wf);
      await this.store.autosave(copy ? this._autoName(t, wf) : t.name, copy ? stampWorkflow(wf, t.name, null, null) : wf);
      t.autosavedAt = Date.now();
      t.clock.wrote(t.autosavedAt);
      t.error = null;
    } catch (e) {
      t.error = String(e?.message || e).slice(0, 60);
    } finally { this.busy = false; this.render(); }
  }

  async save({ as = false } = {}) {
    const wf = this.serialize();
    if (!wf) return;
    const t = this._cur() || (await this.tick(), this._cur());
    let name = t.name;
    const copy = this._isCopy(t, wf);
    if (as || copy || !name || /^Untitled \d{4}-/.test(name)) {
      name = await askName(this.app, as ? "Save project as" : "Save project", name && !/^Untitled /.test(name) ? name : "");
      if (!name) return;
      if ((name !== t.name || copy) && ((await this.store.manifest(name)) || (copy && (await this.store.open(name))))
        && !(await confirmBox(this.app, "Replace project?", `A project called "${name}" exists. Replace it?`))) return;
    }
    try {
      const res = await this.store.save(name, wf, { manifest: this._summary(), ...(copy ? { copy: true, replace: true } : {}) });
      try { this.app.graph.extra = { ...(this.app.graph.extra || {}), ss_project: { name: res.name, saved_at: res.saved_at, id: res.id } }; } catch { /* */ }
      t.name = res.name;
      t.collected = false;
      t.boundName = res.name;          // this tab is the project now, whatever path ComfyUI keeps for it
      // only an id project.json was read back holding (store.save settles both files); another tab's save landing
      // last leaves this graph unconfirmed until the next check
      t.confirmedId = res.confirmed === false ? null : res.id; t.confirmedName = res.name; t.checkKey = `${res.name}|${res.id}`; t.checkedAt = Date.now();
      t.savedAt = res.saved_at;
      t.savedSig = t.sig = workflowSig(wf);
      t.error = null;
      try { await this.app.extensionManager?.workflow?.syncWorkflows?.("workflows"); } catch { /* older frontend */ }
      this.say(res.confirmed === false ? `Saved "${res.name}", but another tab saved it at the same moment and its copy is the one on disk. Reopen the project to see it.`
        : `Saved "${res.name}" (workflows/${res.name}.json).`);
    } catch (e) {
      t.error = String(e?.message || e).slice(0, 60);
      this.say(`Could not save: ${t.error}`);
    }
    this.render();
  }

  _summary() {
    for (const h of this.hosts) { try { return h.summary?.() || {}; } catch { /* */ } }
    return {};
  }

  async load(wf, name) {
    if (!wf) return;
    await this.app.loadGraphData(wf, true, true, name ? `${name}` : null);
    await this.tick();
    const t = this._cur();
    if (t) t.collected = false;          // openCollected sets it again after loading
    if (t && name) { t.name = name; t.boundName = name; }   // opened here as that project (openCollected unbinds it)
  }

  async open(name) {
    const wf = await this.store.open(name);
    if (!wf) { this.say(`No saved project "${name}".`); return; }
    await this.load(wf, name);
    const t = this._cur();
    if (t) { t.savedAt = wf.extra?.ss_project?.saved_at || Date.now(); t.savedSig = t.sig = workflowSig(this.serialize()); }
    this.say(`Opened "${name}".`);
    this.render();
  }

  async newProject() {
    const name = await askName(this.app, "New project", "");
    if (name === null) return;
    let tpl = null;
    try { const r = await this.api.fetchApi("/soundstage/project/template"); if (r.ok) tpl = await r.json(); } catch { /* */ }
    if (!tpl) { this.say("Could not load the Soundstage_App template."); return; }
    const n = name || untitledName();
    await this.load(stampWorkflow(tpl, n, null, null), n);   // no id: the first save writes one
    if (name) await this.save();
  }

  /** Restore one autosave of the open project, or of `project` (the start screen's card menu). */
  async restore(file, project = null) {
    const t = this._cur();
    if (!project && !t?.name) return;
    const pname = project || this._autoName(t);
    const wf = await this.store.readAutosave(pname, file);
    if (!wf) { this.say("That autosave could not be read."); return; }
    if (!(await confirmBox(this.app, "Restore autosave?", `Load the autosave from ${file.replace(/\.json$/, "")} into this tab? `
      + "Your current state is autosaved first, so you can come back to it."))) return;
    if (!project) await this.autosaveNow();
    const name = pname;
    await this.load(wf, name);
    this.say(`Restored the autosave ${file.replace(/\.json$/, "")}. Save to keep it as the project.`);
  }

  // ------------------------------------------------------------------ Collect project (server: soundstage/project/routes.py)

  /** Collect the open project, or a saved one by name (the start screen: its saved workflow, without the live cut exports). */
  async collect(project = null) {
    const t = this._cur();
    const wf = project ? await this.store.open(project) : this.serialize();
    if (!wf || (!project && !t)) { if (project) this.say(`No saved project "${project}".`); return; }
    const name = project || this._ensureName(t);
    let extras = {};
    if (!project) for (const h of this.hosts) { try { extras = { ...extras, ...((await h.collectExtras?.()) || {}) }; } catch { /* */ } }
    this.say(`Collecting "${name}": copying every file it uses into output/soundstage_projects/${name}/ …`);
    try {
      const r = await this.api.fetchApi("/soundstage/project/collect", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, workflow: wf, extras }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || r.status);
      const miss = j.missing?.length ? ` ${j.missing.length} missing (listed in MISSING.txt).` : "";
      this.say(`Collected "${j.name}": ${j.copied} files, ${(j.bytes / 1e6).toFixed(1)} MB.${miss} Downloading the zip…`);
      const a = document.createElement("a");
      a.href = this.api.apiURL(`/soundstage/project/collect/zip?name=${encodeURIComponent(j.name)}`);
      a.download = `${j.name}.zip`;
      document.body.append(a); a.click(); a.remove();
      return j;
    } catch (e) {
      this.say(`Collect failed: ${e?.message || e}`);
      return null;
    }
  }

  async openCollected(name) {
    try {
      const r = await this.api.fetchApi("/soundstage/project/open_collected", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || r.status);
      const n = cleanName(j.name) || name;
      // A collected copy never keeps the id it carries: on the machine it came from, projects/<n>/project.json still
      // holds that id, so projectId() would confirm the copy as the live project and a plain Save would overwrite it
      // with the copy (relinked to output/soundstage_projects/). No id here; its first Save asks for a name (and to
      // replace an existing project of that name) and writes a fresh id.
      await this.load(stampWorkflow(j.workflow, n, null, null), n);
      const t = this._cur();
      if (t) { t.collected = true; t.confirmedId = null; t.boundName = null; }
      this.say(`Opened collected project "${n}", relinked to output/soundstage_projects/${j.folder}/. Save it to keep it as a project here.`);
    } catch (e) { this.say(`Could not open it: ${e?.message || e}`); }
  }

  async uploadCollected() {
    const inp = Object.assign(document.createElement("input"), { type: "file", accept: ".zip,application/zip" });
    inp.addEventListener("change", async () => {
      const f = inp.files?.[0];
      if (!f) return;
      const body = new FormData();
      body.append("file", f);
      this.say(`Uploading ${f.name}…`);
      try {
        const r = await this.api.fetchApi("/soundstage/project/upload_collected", { method: "POST", body });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || r.status);
        await this.openCollected(j.name);
      } catch (e) { this.say(`Could not open the zip: ${e?.message || e}`); }
    });
    inp.click();
  }

  // ------------------------------------------------------------------ the pill and its menu

  say(m) { for (const h of this.hosts) { try { h.say?.(m); } catch { /* */ } } }

  render() {
    const t = this._cur();
    for (const p of this.pills) {
      if (!p.isConnected) { this.pills.delete(p); continue; }
      const s = statusText({ savedAt: t?.savedAt, autosavedAt: t?.autosavedAt, dirty: !!(t && t.sig && t.sig !== t.savedSig),
        autosaveOn: this.autosaveOn, error: t?.error });
      p.dataset.state = s.state;
      p.querySelector(".nm").textContent = t?.name || "Untitled";
      p.querySelector(".st").textContent = s.text;
      p.title = `Project: ${t?.name || "not named yet"}\n${s.text}\nClick for Save, Open, Restore autosave and Collect project.`;
    }
  }

  async menu(anchor) {
    const t = this._cur();
    const [recent, autos, collected] = await Promise.all([
      this.store.list().catch(() => []),
      t?.name ? this.store.autosaves(this._autoName(t)).catch(() => []) : [],
      this.api.fetchApi("/soundstage/project/collected").then((r) => (r.ok ? r.json() : { projects: [] })).then((j) => j.projects || []).catch(() => []),
    ]);
    const sub = (items, a) => openMenu(items, a, { makeIcon: icon });
    const items = [
      { label: "All projects…", icon: "grid-3x3", run: () => this.home?.({ onDemand: true }), title: "The start screen: every project, newest first" },
      { label: "Save", icon: "download", run: () => this.save(), title: "Write the project to workflows/<name>.json (same as Workflow → Save)" },
      { label: "Save As…", icon: "copy", run: () => this.save({ as: true }) },
      { label: "Open…", icon: "file-text", disabled: !recent.length, run: () => sub(recent.map((p) => ({ label: p.name, run: () => this.open(p.name) })), anchor) },
      { label: "New project", icon: "plus", run: () => this.newProject(), title: "A clean Soundstage App in a new tab" },
      { label: "Models…", icon: "download", run: () => globalThis.__ssOpenModels?.({ api: this.api }), title: "See which model files you have and download the missing ones from Hugging Face" },
      "-",
      { header: "Open recent" },
      ...recent.slice(0, 6).map((p) => ({ label: p.name, run: () => this.open(p.name) })),
      ...(recent.length ? [] : [{ label: "(no saved projects yet)", disabled: true }]),
      "-",
      { label: `Restore autosave… (${autos.length})`, icon: "rotate-ccw", disabled: !autos.length,
        run: () => sub(autos.map((a) => ({ label: `${new Date(a.at).toLocaleString()} · ${ago(a.at)} ago`, run: () => this.restore(a.file) })), anchor) },
      { label: this.autosaveOn ? "Autosave: on (turn off)" : "Autosave: off (turn on)", icon: "check",
        run: () => { this.autosaveOn = !this.autosaveOn; writePref(this.autosaveOn); this.render(); } },
      "-",
      { label: "Collect project (zip)…", icon: "package-plus", run: () => this.collect(),
        title: "Copy every file this project uses into one organised folder (scenes / shots / cast) and download it as a zip" },
      { label: "Open collected project…", icon: "upload", run: () => sub([
        ...collected.map((p) => ({ label: `${p.name} · ${p.size_mb} MB`, run: () => this.openCollected(p.name) })),
        ...(collected.length ? ["-"] : []),
        { label: "Upload a collected .zip…", run: () => this.uploadCollected() }], anchor) },
    ];
    sub(items, anchor);
  }

  mountPill(row, before) {
    const p = Object.assign(document.createElement("button"), { type: "button", className: "ss-btn ss-projpill" });
    p.setAttribute("aria-haspopup", "menu");
    p.append(icon("file-text", 14), Object.assign(document.createElement("span"), { className: "nm" }),
      Object.assign(document.createElement("span"), { className: "st" }));
    p.addEventListener("pointerdown", (e) => e.stopPropagation());
    p.addEventListener("click", () => this.menu(p));
    if (before && before.parentNode === row) row.insertBefore(p, before); else row.append(p);
    this.pills.add(p);
    this.render();
    return p;
  }
}

/** Mount the project pill for one stage widget (and a Collect card in ⑦ Deliver). Returns the page controller. */
export function mountProjectBar({ app, api, row, before = null, host = {} }) {
  if (!document.getElementById("ss-project-css")) {
    const s = Object.assign(document.createElement("style"), { id: "ss-project-css", textContent: CSS });
    document.head.append(s);
  }
  const ctl = (window.__ssProject ||= new ProjectController({ app, api }));
  ctl.hosts.add(host);
  // The start screen (web/project/home.mjs): on demand from "All projects…" or the Home button, or on its own for a
  // blank Soundstage App (the host calls ctl.home({ onDemand: false }) when shouldShowHome() says so).
  ctl.home ||= (opts = {}) => {
    const h = [...ctl.hosts].reverse().find((x) => (x.onDemo || x.onScript) && (x.alive?.() ?? true)) || {};
    return openHome({ ctl, api, host: h, tryit: !!window.__demo, askName: (t, v) => askName(app, t, v), ...opts });
  };
  const homeBtn = Object.assign(document.createElement("button"), { type: "button", className: "ss-btn ss-homebtn",
    title: "Home: every project, newest first (the start screen)" });
  homeBtn.setAttribute("aria-label", "Home: all projects");
  homeBtn.append(icon("grid-3x3", 14));
  homeBtn.style.marginLeft = "6px";
  homeBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
  homeBtn.addEventListener("click", () => ctl.home({ onDemand: true }));
  if (before && before.parentNode === row) row.insertBefore(homeBtn, before); else row.append(homeBtn);
  ctl.mountPill(row, before);
  if (host.deliverView) {
    const card = document.createElement("div");
    card.className = "card ss-deliver-card ss-projcard";
    const st = document.createElement("strong");
    st.append(icon("package-plus", 15), "Collect project");
    const p = Object.assign(document.createElement("p"), { className: "lede",
      textContent: "Copy every file this project uses into one folder, organised by scene, shot and character, with the cut and a project.json. Downloads as a zip; open it on another machine with Open collected project." });
    const r = document.createElement("div");
    r.className = "row";
    const go = Object.assign(document.createElement("button"), { type: "button", className: "go", textContent: "Collect project (zip)" });
    go.addEventListener("click", () => ctl.collect());
    const ghost = Object.assign(document.createElement("button"), { type: "button", className: "ghost", textContent: "Open collected project…" });
    ghost.addEventListener("click", () => ctl.menu(ghost));
    r.append(go, ghost);
    card.append(st, p, r);
    host.deliverView.append(card);
  }
  return ctl;
}
