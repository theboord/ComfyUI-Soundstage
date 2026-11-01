# Try-it demo (the "Try it in your browser" link)

The demo is a claude.ai Artifact: **https://claude.ai/artifact/GwtC3yFZtGCsTsiPGbvnAq**. It is the real App code from `web/`, running in the browser on a stand-in ComfyUI that replays real GPU renders. This folder builds it.

## Refresh after a milestone

One command, then one publish:

```sh
python3 tools/tryit/build_tryit.py
```

The build does four things:

- It fetches `origin/main` and copies its `web/` into a throwaway worktree. Half-finished work in the shared tree never ships.
- It stages the page in `$TMPDIR/soundstage_tryit/staging/`.
- It writes `publish_files.json` next to the staging folder. The file lists only what changed since the last publish, plus `null` for files that are live but no longer built.
- It prints both paths.

Then publish with the Artifact tool:

1. `action: "read"` the artifact URL above. A publish to an unread artifact is refused.
2. Publish with these settings:
   - `url`: the artifact URL.
   - `file_path`: `<staging>/index.html`.
   - `files`: the contents of `publish_files.json`.
   - Keep the title. Don't pass `icon`.

   When one publish would go over 255 files or 64 MB, the build splits the list into `publish_files_1.json`, `publish_files_2.json` and so on. Publish them in order.
3. Run `python3 tools/tryit/build_tryit.py --mark-published` and commit `tools/tryit/published.json`. The next build then sends only the next changes.

Test it before you publish:

```sh
cd $TMPDIR/soundstage_tryit && python3 -m http.server 8771 --bind 127.0.0.1 &
node tools/tryit/test_tryit.mjs http://127.0.0.1:8771/local.html /tmp/tryit_shots   # exits 1 on any console error
```

`local.html` is the page with the document skeleton that the Artifact host adds. The test does the following:

- loads every scene;
- goes through the seven steps;
- replays ④ Frame and ⑤ Motion;
- drags a person onto a crate, onto the horse and into a light box;
- applies a stunt;
- switches the physics solver to GPU, which must fall back cleanly without WebGPU;
- opens Ripple, Pose follow and the DCC kit;
- runs every tour stop;
- checks the phone width.

It saves a screenshot of each.

## What's here

| Path | What |
|---|---|
| `build_tryit.py` | The build. Options: `--ref <commit>`, `--web <dir>`, `--out <dir>`, `--media <dir>`, `--mark-published`. |
| `shell/index.html`, `shell/demo.mjs` | The page: the scene picker, the What's new tour and the clip player, around the real App widget. |
| `shell/scripts/api.js`, `app.js`, `glbshim.js` | The stand-in ComfyUI. See "The shims" below. |
| `shell/tour.json` | The What's new stops. Each has a scene, an action (`do`), text and optional clips (`r/<file>`). |
| `scenes/*.json` | The demo scenes: the stage, node properties (`ss_renders`, `ss_script`, `ss_cut`), widgets, the precomputed Look and Advisor, and `candidates` (the ④ Frame variations the replay cycles through). |
| `make_scenes.mjs` | Remakes the generated scenes with the real App in a hidden Chrome: `drycreek`, `stunt`, `physics` and the seven new sets. The new sets are set up from sluglines. Run it against a local build, then build again. `ONLY=stunt,fire` limits it. |
| `media.json` | Clips and stills encoded into the media cache from `share/`. |
| `published.json` | The sha256 of every live file, written by `--mark-published`. |
| `test_tryit.mjs` | The click-through test. |

### The shims

- **`scripts/api.js`** replays the renders that each scene's workflow recorded. ④ Frame cycles through the real FLUX 3 Klein variations. ⑤ Motion plays the draft and the final.
- **`api.js`** also answers the Look compile and the Advisor from saved results.
- **`api.js`** keeps uploads in the tab.
- **`api.js`** answers every other server route with a toast: "… is available in the full install (ComfyUI with a GPU)". This covers the Director chat, Video to 3D, Ripple and Pose renders, the Layer Pack, world uploads and the vcam. It never throws an error.
- **`scripts/app.js`** stands in for ComfyUI's graph. It holds the nodes the App reads, using the same ids as `example_workflows/Soundstage_App.json`.
- **`scripts/glbshim.js`** maps `.glb` to `.glb.b64.txt` and the DCC builder scripts `.py` to `.py.txt`. The host serves web media types only.

When a milestone adds a node the App reads, add it in `shell/demo.mjs`. When it adds a server route, add it to `FULL` in `api.js`.

## Media

The media cache is `~/OpenHiggsfieldContest/tryit_media` (`r/`, `refs/`). It holds every published render. The original pod renders were copied in once. `media.json` entries are encoded on demand from `share/`, using the same recipe as the original renders:

- videos: 960 px, H.264 crf 28, AAC 96k;
- stills: 1280 px JPEG.

Keep each file small. The Artifact limits are 16 MB per file, and 255 files and 64 MB per publish.

The build refuses any path containing `soundstage_private`, `private_mike_test` or "24-hour". Never add those.
