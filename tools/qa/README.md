# Visual regression guard

`tools/qa/visual_baseline.mjs` protects the App's look. Every QA round runs it first.

It opens the App in a hidden Chrome at **1280×800, 1440×900 and 1920×1080** and captures the same screens each time:

| Screen | What it shows |
|---|---|
| `app_panel` | ComfyUI App mode, with the stage in the narrow side panel |
| `firstrun_card` | The full workspace on a brand-new stage, with the "Let's make a shot" card |
| `step_1_script` … `step_7_deliver` | The seven steps, with the demo scene loaded |
| `toprow_render_queued` | ③ Set while a render is queued: Stop in the step row (elsewhere Stop is kept hidden, since the pod's queue is shared) |
| `canvas_hidden` | ③ Set with every floating panel hidden (H) |
| `scriptsync` | ScriptSync, the lined script |
| `import_video_chooser` | Import video's "What is this video for?" |
| `motion_follow_ripple` | ⑤ Motion › Follow › Ripple edit |
| `motion_sound_pop` | ⑤ Motion › the Sound & music pop-over |
| `physics_panel` | ③ Set › a car selected › Physics |
| `deliver_dcc_kit` | ⑦ Deliver › the Blender · Unreal · Maya · Nuke card |

Each capture is compared with its baseline in `tests/visual/baselines/<size>/<screen>.jpg`. Baselines are JPEG, 1280 wide, about 60 KB each.

Besides pixels, the guard also records layout facts for every screen:

- console errors;
- whether the page itself scrolls (`scrollHeight > innerHeight`) or scrolls sideways;
- clipped text (`scrollWidth > clientWidth`), split into deliberate ellipsis and hard cuts;
- floating panels that overlap;
- boxes that scroll;
- buttons cut off by the window edge.

Anything new compared with the baseline's `metrics.json` is flagged.

## Run it

```sh
node tools/qa/visual_baseline.mjs                  # compare; exits 1 if anything failed
node tools/qa/visual_baseline.mjs --update         # accept this run as the new baselines
node tools/qa/visual_baseline.mjs --sizes 1440x900 --only step_3_set,physics_panel
node tools/qa/visual_baseline.mjs --local ui/firstrun.mjs   # serve web/ui/firstrun.mjs from this repo (test before deploying)
```

Other options:

- `--threshold 0.02` sets the share of pixels allowed to change (default 2 %).
- `--port 9770` sets the first DevTools port; each size uses the next one.
- `--jobs 3` sets how many sizes run in parallel.
- `--out <dir>` changes the output folder.

The run writes to `tests/visual/out/<time>/`, which git ignores:

- `report.md` and `report.json`;
- each capture;
- a `*.diff.jpg` for each changed screen, with the changed pixels in red over a grey copy of the new capture.

### What each status means

| Status | Meaning |
|---|---|
| PASS | Within the threshold, and no new layout problems. |
| CHANGED | More pixels moved than the threshold allows. If the change is intended, check the diff, then run `--update`. |
| LAYOUT | The pixels are close, but something new scrolls, clips, overlaps or logs an error. |
| NEW | There is no baseline yet. |
| ERROR | The screen could not be reached. |

## Safety

The guard never queues a render. A script runs before ComfyUI's own code and answers locally every non-GET request to these paths:

- `/prompt`, `/queue`, `/interrupt` and `/free`;
- `/settings` and `/userdata`;
- `/upload/` and `/soundstage/`.

Downloads are swallowed, file pickers never open, and each run uses a throwaway Chrome profile.

The guard needs Google Chrome and ComfyUI at `http://127.0.0.1:8189` (set `SS_URL` to use another address).

`tools/qa/lib.mjs` is the shared driver: launch, guard, mouse and keys, screenshots and `METRICS`. QA rounds build their end-to-end scripts on it.

## Watching the queue

Never poll `GET /queue` or `GET /history` from a tool, a QA driver or an agent. ComfyUI encodes every queued and finished prompt in full for those two endpoints, and a busy Soundstage scene used to be megabytes per prompt. On 2026-11-01 a few queued renders plus a few polling pages kept the pod's event loop at 100% CPU and the server stopped answering.

Use these instead:

- `GET /soundstage/queue_summary` gives `{running, pending, items: [{prompt_id, state, position, client_id, label, number}], ms}`. It never includes a payload. `?ids=a,b` lists only those prompts, `?client_id=` lists only one client's, and `?limit=` caps the list (the counts always cover the whole queue). `position` 0 is the running prompt and 1 is next. In `lib.mjs` this is `queueSummary({ ids, clientId })`.
- `GET /history/{prompt_id}` gives one finished prompt (yours), never the whole history.
- ComfyUI's websocket events (`execution_start`, `executing`, `progress`, `executed`, `execution_error`) report progress.

Big stages travel by reference: the 3D Stage node's input reads `{"stage_ref": "<sha256>", "bytes": N, "frames": F}`, and the JSON itself sits in ComfyUI's `input/soundstage_stages/`. `GET /soundstage/stage_store/<sha256>` returns it ([soundstage/stagestore.py](../../soundstage/stagestore.py)). Only queueing swaps the stage for a reference: ComfyUI's Export (API) and a saved workflow keep the stage inline, so they open on any server. A render's PNG or MP4 metadata carries the reference, so its set restores only on the server that rendered it, while `input/soundstage_stages/` is kept.

## When a baseline should change

Update the baselines in the same commit as an intended visual change, and say so in the commit message.

Never update them to make a failure go away without looking at the diff.

## Menus and pop-overs (popover_sweep.mjs)

Every menu, drop-down, context menu and pop-over opens in one top-level layer (`web/ui/popover.mjs`, on `document.body`, `position:fixed`): it flips to the side of its anchor that has room, is clamped to the window, scrolls inside when taller than the window, closes on Esc and on a click outside, and moves between items with the arrow keys, Home and End. Build new menus with `openPopover(el, { anchor })` (or `placePopover` for the maths), never as a `position:absolute` child of a panel: a scrolling box cuts those off.

`tools/qa/popover_sweep.mjs` checks them in a hidden Chrome with the demo scene, at **1024×640, 1280×800, 1600×1000 and 1920×1080**, with Tracks, Presets, Physics, Parts and Director open in turn. Each menu is opened with a real click and must lie fully inside the window, nothing may cover it, every item must be clickable (scrolled inside the menu only), Esc must close it and the layer must be empty afterwards.

```sh
SS_ANGLE=metal node tools/qa/popover_sweep.mjs                       # all sizes and panels; exits 1 on a failure
SS_ANGLE=metal node tools/qa/popover_sweep.mjs --sizes 1024x640 --only strip_add,tools_menu --states none,tracks
SS_ANGLE=metal node tools/qa/popover_sweep.mjs --local ui/popover.mjs,cut/strip.mjs   # check a fix before deploying it
```

A trigger that sits under the panel a state opened (the Physics panel over the shot strip at 1024 and 1280 wide) is listed as UNDER PANEL: a layout note, not a menu failure. Results: `report.md`, `report.json` and a PNG of every failure, in `tests/visual/out/popovers-<time>/`.

## Headless GPU note (2026-11-01)
Run demo-scene flows with real GPU rendering (`--use-angle=metal`). Under SwiftShader, "Try the demo scene" keeps the page busy for minutes drawing shot-row previews, which looks like a freeze. Also, never call CDP `DOM.getDocument({depth:-1, pierce:true})` on the App: with 10k+ nodes it never returns. Find inputs with `Runtime.evaluate` and use `DOM.setFileInputFiles` by objectId.
