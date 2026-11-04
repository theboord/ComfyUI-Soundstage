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

## Where things are saved

All in ComfyUI's per-user folder (`ComfyUI/user/<user>/`), never in `output/`:

```
workflows/<name>.json                    the project: a normal ComfyUI workflow, opens anywhere
projects/<name>/project.json             {format, v, name, workflow, created, saved_at, saves, title, scenes, shots}
projects/<name>/autosave/<stamp>.json    {name, saved_at, workflow}, newest 20 kept
soundstage/scripts/<hash>.json           a long script's full text (unchanged, as before)
```

The workflow carries its project name in `extra.ss_project`, so a project opened through Workflow → Open still
autosaves into its own folder. Workflows saved before this change have no `ss_project` and open as before. They are
autosaved as `Untitled <date> <time>` once you change something.

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

- The pill writes the files itself. ComfyUI's own workflow tab can still show its "modified" dot after a Save from the
  pill, because the frontend's change tracker does not expose a clean way to mark a tab saved. The file on disk is
  the saved one either way.
- Takes: `ss_renders` keeps the latest render of each kind per shot, so older takes overwritten there are not
  collected. Frame variations and the chosen frame are.
- The cut exports in `cut/` come from the live scene's editor. Other scenes' cuts are in `timeline.json` only.
- Voice samples are matched by the Character Voice name set in Cast; voices used only inside a performance take are not.
