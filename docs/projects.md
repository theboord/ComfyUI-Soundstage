# Projects: save, autosave and Collect project

A Soundstage project is a ComfyUI workflow. Everything the App knows lives in the stage node's `node.properties`
(script, scenes, shots, cast, chosen frames, takes, per-shot LTX settings, the cut), plus the long script text in
ComfyUI userdata. Before this, a project only survived in the browser's tab restore unless you did
Workflow → Save. A reload or a browser reset could wipe it, and once one did.

## The project pill

At the top of the App, next to Guide, there is a pill with the project's name and its state:

- `Saved 12 s ago · Autosave on`
- `Unsaved changes · autosaved 40 s ago`
- `Not saved yet · Autosave on`
- `Save failed: … ` (in red)

Click it for the menu:

| Item | What it does |
|---|---|
| **Save** | Writes `workflows/<name>.json` through ComfyUI's userdata API, the same file Workflow → Save writes, and `projects/<name>/project.json`, a small manifest. An unnamed project asks for a name first. |
| **Save As…** | The same, under a new name. Asks before it replaces an existing project. |
| **Open…** / **Open recent** | The saved projects, newest first. |
| **New project** | Asks for a name and opens a clean `Soundstage_App` template in a new workflow tab. |
| **Restore autosave…** | The project's last 20 autosaves. The current state is autosaved first, so you can go back. |
| **Autosave: on/off** | Remembered per browser. On by default. |
| **Collect project (zip)…** | See below. Also a card in ⑦ Deliver. |
| **Open collected project…** | Re-opens a collected project from the server, or uploads a collected `.zip` and opens that. |

## The start screen

Like Avid's project window, Resolve's Project Manager or Premiere's Home screen. It covers the whole window
([web/project/home.mjs](../web/project/home.mjs)).

**When it shows:**

- On its own, once per workflow tab, when the App opens on a blank Soundstage App. Blank means no `extra.ss_project`, the
  untouched default stage, no script and no renders.
- Never for a workflow that already holds a named project, such as a restored tab.
- Never in the try-it demo.
- On demand from the pill's **All projects…** or the **Home** button (the grid icon in the top row).

**Left column:**

- **＋ New project**: asks for a name.
- **Open project…**: moves the focus to the list.
- **Open collected project…**: the collected folders on the server, or upload a collected zip.
- **Try the demo scene**: the first-run demo loader.
- **Import a script**: into this tab when it is still a blank App. Otherwise it starts a New project and you choose the
  file in its ① Script (a browser will not open a file picker after the tab reloads).
- **Start with this blank stage** (or **Back to the App**): closes it.

**Main area:** recent projects, newest first, with a search box and a Recent / Name sort (remembered per browser).
Each card shows:

- the picture: the latest chosen first frame, else a look frame, else the final or draft render (as a video poster),
  else a clay frame, else the project's initial on a colour picked from its name;
- the name, "Saved 2 h ago" and scenes · shots · takes;
- an **Autosave newer** badge when the newest autosave is later than the last Save.

The ⋯ menu has Open, Duplicate…, Rename…, Collect (zip), Restore autosave… and Delete…. **Delete** asks on the card
itself and then moves the project to `projects/.trash/<name> <stamp>/`, with its workflow as `workflow.json`. Nothing
is deleted. `POST /soundstage/project/untrash` puts it back.

**Keys:**

- Arrows move between cards, and Home / End jump to the first and last.
- Enter opens. Enter in the search box opens the first match.
- ⌘N / Ctrl+N starts a new project.
- Esc closes it when it was opened on demand.

**Try-it demo:** only Try the demo scene and Load a script show, and nothing calls the server.

Server (`soundstage/project/library.py`), all in the requesting user's folder (`user/<user>/`, as ComfyUI's
`/userdata` resolves it):

```
GET  /soundstage/project/list        -> {"projects": [{name, id, saved_at, counts{scenes,shots,takes}, thumb, thumb_kind,
                                         autosaves, autosave_at, autosave_newer}]} newest first (id: see Project id)
POST /soundstage/project/duplicate   {name, to}   workflow + manifest, not the autosaves
POST /soundstage/project/rename      {name, to}   folder, autosaves and workflow; the stamp inside is updated
POST /soundstage/project/trash       {name}       -> projects/.trash/<name> <stamp>/
GET  /soundstage/project/trash       -> {"trash": [...]}
POST /soundstage/project/untrash     {trash}      back under its name, or "<name> (restored)"
```

Names must be one clean path segment and never start with a dot, so `.trash` can't be opened, renamed or trashed.
Thumbnails are `/view` URLs, and only for files that exist inside ComfyUI's output, input or temp folder.

## Where things are saved

All in ComfyUI's per-user folder (`ComfyUI/user/<user>/`), never in `output/`:

```
workflows/<name>.json                    the project: a normal ComfyUI workflow, opens anywhere
projects/<name>/project.json             {format, v, id, name, workflow, created, saved_at, saves, title, scenes, shots}
projects/<name>/autosave/<stamp>.json    {name, saved_at, workflow}, newest 20 kept
soundstage/scripts/<hash>.json           a long script's full text (unchanged, as before)
```

The workflow carries its project name in `extra.ss_project`, so a project opened through Workflow → Open still
autosaves into its own folder. Workflows saved before this change have no `ss_project` and open as before. They are
autosaved as `Untitled <date> <time>` once you change something.

## Project id

Each saved project has an id, `p_` and 8 lowercase hex digits (for example `p_3fa85f64`). Ask's memory uses it to
know which project a memory belongs to, so it must not move to a different project by accident.

- **Where:** `projects/<name>/project.json` (`id`) and the workflow's `extra.ss_project.id`. Save writes both.
- **When it is kept:** Save keeps the project's id only when the workflow being saved carries that same id. Any
  other save gets a fresh id: Save As to a new name, a project saved before ids existed, a workflow that carries
  another id, a workflow with no id at all (even one that names this project, so someone else's old pre-id
  workflow with the same name never takes your id), or a workflow saved under a name whose `projects/<name>/`
  folder was left behind after its workflow was deleted from ComfyUI's sidebar. The cost: a second tab opened before
  the first Save, canvas undo back past the first Save, or a restored autosave from before it gets a fresh id when it
  is saved.
- **Two tabs saving in turn:** one exception to the rule above. A graph carrying an id that this same page saved for
  the project (same `created` stamp in `project.json`) takes the id another tab's save has since put in
  `project.json`. So when two tabs (pages) save one project in turn, the id changes once (the second tab's first
  save) and then stays: tested with 8 alternating saves, 2 ids in all, the last 7 the same. Before this, every save
  made a new id. It is still a change: memory keyed to the first id must re-key after a Save
  (`await __ssProject.project()`). A page that is reloaded forgets what it saved, so a stale graph saved from a
  reloaded page gets a fresh id once. A project replaced after Trash has a new `created` and is never adopted into.
  Nor is a project replaced with other content: a save that makes a fresh id over a copy, a graph carrying another
  id, a graph named for another project, or a confirmed "Replace project?" (Save As `Q` under the name `P`; the pill
  passes `replace: true`) resets `created`, so a tab still holding `P`'s old id gets a fresh id of its own instead of
  the one made for `Q`. Known limit: a direct `store.save` of a graph that names no project and is passed without
  `replace` keeps `created`, as a pre-id tab of the same project would.
- **Two saves at the same moment:** saves of one project from one page run one after the other. Across tabs there
  is no lock, so after writing, Save reads `workflows/<name>.json` and `project.json` back and, while their ids
  differ, sets `project.json` to the saved workflow's id (up to 6 tries). Save then reports `confirmed: true` only
  when that id is the one this graph carries; otherwise the pill says the other tab's copy is the one on disk.
  Still open: a save that settled just before the other tab's write landed says confirmed although the disk has
  moved on. `projectId()` can then report a stale id until the next check (at most 15 s, or the next Save/Open). In
  a 200-trial test with random delays this happened in 2-8 of 400 saves; the two files never disagreed at the end.
- **Known limit, two pages creating the same new name at once:** New project checks whether the name is taken and
  then saves (`projectbar.newProject`, then `store._save`). With no lock between the check and the write, two pages
  creating the same new project name at the same moment can both pass the check, and the two-saves settling above can
  then leave both sharing one id. Not fixed; create a new project from one page at a time.
- **New project under an existing name:** New project with the name of a saved project asks "Replace project?"
  first. No writes nothing; Yes saves the template with `replace: true`, so it gets a fresh id and a new `created`
  and a tab still holding the old project never adopts the template's id.
- **Collected copy:** Open collected project drops the id the copy carries. On the machine it was collected from,
  `projects/<name>/project.json` still holds that id, so the copy would confirm as the live project and a plain Save
  would overwrite it. Its first Save asks for a name, asks before replacing an existing project of that name, and
  writes a fresh id.
- **ComfyUI's own copies:** a workflow open from any path other than `workflows/<name>.json` (ComfyUI's Workflow →
  Duplicate or Save As, an exported `.json` dragged in, a render dragged in), or a temporary never-saved workflow, is
  a copy, even though it carries the project's name and id in `extra.ss_project`. It is treated like a collected
  copy: `projectId()` is `null` (`project()` answers `confirmed: false, copy: true`, `current()` adds `copy: true`),
  its first Save asks for a name and asks before replacing a project of that name, and it gets a fresh id. Its
  autosaves go to `projects/<name> (copy)/autosave/` with no id, so they never push the project's own autosaves out.
  Once saved from the pill, that tab is the project and later Saves are ordinary. `store.save(name, wf, {from: path})`
  and `store.confirmProjectId(wf, {path})` apply the same rule outside the pill; `store.save` refuses (error code
  `exists`) to overwrite an existing project from a copy unless `replace: true` is passed.
- **Library:** Duplicate gives the copy a fresh id (in both files). Rename, Trash and Untrash keep it.
- **Old projects:** a project saved before ids existed has none (`id: null` in the list) until its next Save.
  Opening, listing or autosaving it never writes one.
- **Reading it:**
  - In the page: `window.__ssProject.projectId()` gives the open workflow's id only once it is confirmed against
    the saved `project.json` of the same name, else `null`. It is `null` when the project is not saved yet, is an old
    project not saved since, was renamed in the library while the tab stayed open, or is a collected or exported copy
    whose `project.json` is not here, or was opened with Open collected project and not saved yet. A Save, an Open,
    and a check every 15 s confirm it. It only reads. `window.__ssProject` is assigned once per page in
    `mountProjectBar` (`web/project/projectbar.mjs`).
  - `await window.__ssProject.project()` reads `project.json` now: `{id, name, graph_id, manifest_id, confirmed}`.
  - `window.__ssProject.current()` gives `{id, name}` as the graph says, unconfirmed. Forget uses it to pick the
    project whose copies it cleans.
  - From `web/project/store.mjs`: `projectIdOf(workflow)` (the graph's id, unconfirmed), `await
    store.confirmProjectId(workflow)`, or `await store.projectId(name)`, which reads `project.json`.
- **Tab state:** the pill keeps a tab's state (bound project, confirmed id) per ComfyUI workflow object, not per path.
  A project tab opened from the pill and closed, then an older exported `<name>.json` dragged in at the same path,
  is a copy again (it inherits nothing); the state of tabs ComfyUI no longer lists in `openWorkflows` is dropped.
  Not checked against a live ComfyUI frontend: if it swapped the workflow object of an open tab (for example on its
  own Save), that tab would lose its bound state and be judged by its path again.
- **Not told apart:** a copy is told apart only by the path ComfyUI opened it from. A file copied outside ComfyUI over
  `workflows/<name>.json` itself is the project.
  - On the server: `GET /soundstage/project/list`, where each project has an `id` (`null` for an old project).

## Autosave

- The App looks at the open workflow every 3 s. Pan and zoom are not changes; anything else is.
- It autosaves 4 s after the last change, or every 60 s while you keep changing things. Nothing changes, nothing is written.
- Only workflows with a Soundstage stage are autosaved.
- An unnamed project autosaves as `Untitled 2026-11-04 1432`. Save gives it a real name. The untitled autosaves
  stay under the untitled folder.
- Closing or reloading the tab with changes since the last Save asks first (the browser's own "Leave site?" box).
  It also tries one last autosave, which may not land before the tab goes.

## Collect project

Like Avid Consolidate or Resolve Media Management. It copies every file the project names into one folder, organised the
way film post works, and downloads it as a zip:

```
<Project>/
  project.json            script, Director's Book, scenes, shots, cast, locations, per-shot settings, takes
                          (the chosen one marked), the cut, the workflow, and a relink table
  script/                 script.json (full text), lined_script.json (coverage / ScriptSync), directors_book.json
  cast/<character>/       reference images, cast sheets (charsheet_*), Character Voice samples (voice/)
  locations/<set>/        location references; locations/set/ for set GLBs
  scenes/<S01>/shots/<S01_010>/
     clay/ frames/ refs/ takes/draft/ takes/final/ mattes/ depth/ camera/ sound/ layerpack/
  cut/                    timeline.json + EDL, Avid locators, Premiere XML, FCPXML, OTIO, RELINK.txt
  README.txt              what each folder holds
  MISSING.txt             files the project names that were not found (only when there are some)
```

- The folder is written on the server at `ComfyUI/output/soundstage_projects/<Project>/`. Collecting again replaces it.
- Files are copied, never moved, and named `<shot>_<kind>_<take>.<ext>` (for example `S01_010_draft_01.mp4`).
- Scenes are `S01`, `S02`… from the script's scene numbers. Shots are `S01_010`, `S01_020`… in shooting order. Shots with
  no scene go under `S00`.
- What gets mapped: every file reference in `ss_renders` (clay, look, draft, final, final with sound), `ss_chosen`
  (the chosen frame), `ss_ltx` and `ss_shot_cast` (per-shot audio and reference inputs), `ss_cast` (cast and location
  references), and any other `ss_*` property or set model that names a file.
- The shot's newest Layer Pack (`output/soundstage_layerpacks/<shot>_<stamp>/`) is copied to `layerpack/` when one
  exists. It is matched on the shot's id, name or code.
- Missing files go into `MISSING.txt`. They are not an error, and the rest is collected.

### Open a collected project (another machine)

1. Copy the zip to the other machine.
2. In the App, choose project pill › Open collected project › Upload a collected .zip. Or unzip it yourself into
   `ComfyUI/output/soundstage_projects/` and pick it from the list.
3. The workflow from `project.json` opens in a new tab. Every file reference is relinked to the copies in
   `output/soundstage_projects/<Project>/…`. Files that were missing keep their old reference.
4. Save it to make it a project on that machine. The first Save asks for a name and gives it a fresh project id
   (the copy's own id is dropped on open), and asks before replacing a project of the same name.

### Server routes

`soundstage/project/routes.py`:

```
POST /soundstage/project/collect           {name, workflow, extras?} -> {name, copied, missing, bytes, zip}
GET  /soundstage/project/collect/zip?name=  the collected folder as a zip
GET  /soundstage/project/collected         collected projects on this server
POST /soundstage/project/open_collected    {name} -> {name, folder, workflow (relinked), project}
POST /soundstage/project/upload_collected  multipart "file" -> {name}
GET  /soundstage/project/template          the Soundstage_App template (New project)
```

Path safety:

- Project names are cleaned to one path segment (no `/`, `\`, `..`, leading dot or Windows-reserved names).
- Every source must resolve inside ComfyUI's output, input or temp folder, or `user/soundstage/voices/`. Anything
  else is listed as missing and never read.
- Every destination must resolve inside the project folder.
- Uploaded zips must hold exactly one top folder with a `project.json`. A zip entry that would land outside it, or a
  symlink, rejects the whole zip.

## Known gaps

- The start screen decides "App mode" by whether the stage is on screen. ComfyUI's frontend has no App-mode flag that
  Soundstage reads, so a blank Soundstage_App opened in the graph view shows it too. Start with this blank stage closes it.
- Card counts and thumbnails are read from each project's saved workflow every time the list opens. Hundreds of large
  projects will make that slower.

- The pill writes the files itself. ComfyUI's own workflow tab can still show its "modified" dot after a Save from the
  pill, because the frontend's change tracker does not expose a clean way to mark a tab saved. The file on disk is
  the saved one either way.
- Takes: `ss_renders` keeps the latest render of each kind per shot, so older takes overwritten there are not
  collected. Frame variations and the chosen frame are.
- The cut exports in `cut/` come from the live scene's editor. Other scenes' cuts are in `timeline.json` only.
- Voice samples are matched by the Character Voice name set in Cast; voices used only inside a performance take are not.
