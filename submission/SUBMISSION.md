# Open Source Higgsfield: submission checklist

Deadline: Friday 2026-10-30, 9:00 am PT.

## What Soundstage does (feature list for the form)

A ComfyUI node pack + App: a film set inside ComfyUI. One-screen workspace in seven steps, in production order. 100% open weights by default; partner API models are opt-in only (`SOUNDSTAGE_PARTNER_MODELS=1`).

1. **Script.** Import Fountain, Final Draft (.fdx), PDF or text. Per-scene outline, breakdown and director's notes; a scene strip over Set / Frame / Motion; auto scene setup (pick a scene and its location, cast and time of day go on the stage).
2. **Cast & Locations.** Reference sheets for characters, props and locations; **Generate all missing** with FLUX 3 Klein in one click; a per-shot cast picker; edit any reference in Paint Studio.
3. **Set.** Block the scene in 3D: clay actors with sculpted hair, horses, cars, props, lights, weather. **Pose in 3D** down to the fingertips with IK; real **camera rigs** (tripod, dolly, slider, jib, Steadicam, handheld, drone) with a camera icon at every key and a **Top** plan view; **motion capture** from any video or the webcam (SAM 3D Body); **Video → 3D Stage** rebuilds a clip as a set.
4. **Frame.** FLUX 3 Klein (or Krea 2 + stage depth) paints the first frame from the clay render; **Paint Studio** for fill, remove and extend.
5. **Motion.** LTX-2.5 + Layout-to-Render IC-LoRA animates each shot with sound, following the blocking; type a line and LTX's own voice speaks it, lip-synced; **film-look swatches** re-render the same animation in any look; Draft / Final / Final HQ tiers.
6. **Review.** 3-way **Ladder** (Clay | Draft | Final); approvals (Approved / Needs changes with one-click Redo / Rejected); Avid-style **dailies bins** per scene and a ScriptSync-style **lined script**.
7. **Deliver.** One cut video; **NLE export** to Premiere, Avid and Resolve at the source spec (4K / 8K / RED via proxy relink); a **VFX Layer Pack** (mattes, layers, depth, the staged camera).

## Requirements and where each is met

| # | Requirement | Where it is met | Status |
|---|---|---|---|
| 1 | Built with ComfyUI | A ComfyUI custom node pack (`__init__.py`, `soundstage/`) and App-mode workflows (`example_workflows/`). The whole pipeline runs as ComfyUI nodes; the UI is a ComfyUI frontend extension (`web/`). | Done |
| 2a | Open-source license | `LICENSE` (MIT). Third-party code and its licenses: `THIRD_PARTY_NOTICES.md`. Model licenses: `MODELS.md`. | Done |
| 2b | Enough setup detail to run it on your own machine | `README.md` → Install and Run it locally; `MODELS.md` (every file, folder, source); `requirements.txt`; `tools/install_runpod.sh` (one-shot Linux/RunPod install). | Done |
| 3 | Other tools and models explained in the demo video | End card in `submission/DEMO_VIDEO_SCRIPT.md` lists every model and tool. Also in README → Credits and Models and licenses. | Script done; video TODO |
| 4 | Lawful, SFW, no unlicensed IP or likenesses | Previz figures are faceless; demo scenes are generic (riders, cars, a flashlight search). 3D models are CC0 (Quaternius). Style and lighting presets are written in our own words and use no stills or real likenesses (`THIRD_PARTY_NOTICES.md` → Data). All models are used under their published licenses. | Done; re-check the final video |
| 5a | GitHub repo with app code, workflow files, license, local run instructions | https://github.com/theboord/ComfyUI-Soundstage: code (`soundstage/`, `web/`), workflows (`example_workflows/`), `LICENSE`, `README.md`, `docs/TUTORIAL.md`. | Pushed |
| 5b | Demo video, 2 minutes or less | The trailer, `docs/media/soundstage_showcase.mp4` (upload to YouTube). Script: `submission/DEMO_VIDEO_SCRIPT.md`. | Upload TODO |
| 5c | Optional link to try it | App demo https://claude.ai/artifact/GwtC3yFZtGCsTsiPGbvnAq (in README → Try it): one link, the full App, every step. | Share publicly TODO |
| 5d | Social post linking the demo video with #OpenSourceHiggsfield | Drafts: `submission/SOCIAL_POST.md`. | Post TODO |

## TODO before the deadline (human)

1. ~~GitHub username~~ (done: `theboord`).
2. ~~Create the repo and push~~ (done: `main` on github.com/theboord/ComfyUI-Soundstage).
3. **Share the two artifact links publicly** (App demo and stage-only page), then open each one in a private window to confirm it loads.
4. **Upload the trailer** (`docs/media/soundstage_showcase.mp4`, 2:00 or less) to YouTube, public or unlisted; title, description and chapters are in `submission/SOCIAL_POST.md`.
5. **Post on social** with the video link, the repo link and #OpenSourceHiggsfield (`submission/SOCIAL_POST.md`).
6. **Submit the form** with the repo URL, video URL, try-it link and post URL. If the form asks which Comfy surfaces were used, the App runs locally in App mode; `tools/soundstage_sdk.py` uses the Comfy SDK; partner API nodes are opt-in only (`SOUNDSTAGE_PARTNER_MODELS=1`); the default is 100% open weights.
7. Optional: review `docs/decisions.md`. It is the raw development log and mentions internal notes; trim it if you would rather not publish them.
