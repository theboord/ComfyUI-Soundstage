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
  is saved. Two tabs saving a brand-new project at the same time end up with different ids, and the id keeps
  changing between them until one tab is closed.
- **Library:** Duplicate gives the copy a fresh id (in both files). Rename, Trash and Untrash keep it.
- **Old projects:** a project saved before ids existed has none (`id: null` in the list) until its next Save.
  Opening, listing or autosaving it never writes one.
- **Reading it:**
  - In the page: `window.__ssProject.projectId()` gives the open workflow's id only once it is confirmed against
    the saved `project.json` of the same name, else `null`. It is `null` when the project is not saved yet, is an old
    project not saved since, was renamed in the library while the tab stayed open, or is a collected or exported copy
    whose `project.json` is not here. A Save, an Open, and a check every 15 s confirm it. It only reads.
  - `await window.__ssProject.project()` reads `project.json` now: `{id, name, graph_id, manifest_id, confirmed}`.
  - `window.__ssProject.current()` gives `{id, name}` as the graph says, unconfirmed. Forget uses it to pick the
    project whose copies it cleans.
  - From `web/project/store.mjs`: `projectIdOf(workflow)` (the graph's id, unconfirmed), `await
    store.confirmProjectId(workflow)`, or `await store.projectId(name)`, which reads `project.json`.
- **Not told apart:** a copy made with ComfyUI's own Save As or Duplicate, and a render dragged back in, carry the
  source project's name and id, so they confirm as that project.
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
4. Save it to make it a project on that machine.

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
