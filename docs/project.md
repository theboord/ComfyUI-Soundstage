# Shot Project: a versioned home for every shot

A take should not live as `final_00041_.mp4` in a pile. Shot Project publishes it as the next **version** of a shot,
in a folder any tool can read:

```
output/soundstage_projects/<project>/
  SEQ010/SH010/final/
    v001/  media/final_00041_.mp4   version.json   recipe.json   graph.json   workflow.json   takecheck.json
    v002/  ...
    versions.json   approved.json
```

What a version keeps:

- **The media**: the video, and optionally a Layer Pack folder or a second file (copied whole), each with its size
  and SHA-256 in `version.json`, plus your note, the author and the time.
- **`recipe.json`**: the stage and shot recipe inside the MP4, so the set can be restored from the version.
- **`graph.json` / `workflow.json`**: the exact ComfyUI graph behind the take.
- **`takecheck.json`**: the take's saved check results (freezes, jumps, face drift, Follows your blocking), when they exist.

**Approved.** One version per shot task can be marked approved (`approved.json`). Asking for the approved version of
a shot with nothing approved is an error, not a quiet fallback to the latest.

## Nodes

- **Soundstage · Publish Version** (`Soundstage/Project`): take in, next version out. Optional `approve` and `extra`
  (a Layer Pack folder).
- **Soundstage · Load Version**: a shot's `latest`, `approved` or numbered (`v003`) version as a VIDEO, its path and its
  record, so another workflow can pick the shot up.

## HTTP

- `POST /soundstage/project/publish` `{file, project, sequence, shot, task, note?, approve?}`
- `GET  /soundstage/project/versions?project=&sequence=&shot=&task=`
- `POST /soundstage/project/approve` `{project, sequence, shot, task, version}`

## Honest limits

- This is a folder convention plus two nodes and three routes. There is **no project browser window and no live link
  into Nuke, Maya or Houdini**; the builder scripts in a published Layer Pack are the way in.
- The App has no Publish button yet; use the node or the route.
- Folder names are made safe (letters, digits, `_`, `-`); nothing can write outside the project folder.
- A version exists only once its `version.json` is written, so a crash mid-copy leaves nothing half-published.

Code: [soundstage/shotproject/](../soundstage/shotproject/__init__.py), [soundstage/nodes_project.py](../soundstage/nodes_project.py).
Tests: [tests/test_shotproject.py](../tests/test_shotproject.py).
