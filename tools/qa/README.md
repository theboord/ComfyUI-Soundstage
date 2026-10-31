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

## When a baseline should change

Update the baselines in the same commit as an intended visual change, and say so in the commit message.

Never update them to make a failure go away without looking at the diff.
