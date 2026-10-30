# Open Source Higgsfield: submission checklist

Deadline: Friday 2026-10-30, 9:00 am PT.

## Requirements and where each is met

| # | Requirement | Where it is met | Status |
|---|---|---|---|
| 1 | Built with ComfyUI | A ComfyUI custom node pack (`__init__.py`, `soundstage/`) and App-mode workflows (`example_workflows/`). The whole pipeline runs as ComfyUI nodes; the UI is a ComfyUI frontend extension (`web/`). | Done |
| 2a | Open-source license | `LICENSE` (MIT). Third-party code and its licenses: `THIRD_PARTY_NOTICES.md`. Model licenses: `MODELS.md`. | Done |
| 2b | Enough setup detail to run it on your own machine | `README.md` → Install and Run it locally; `MODELS.md` (every file, folder, source); `requirements.txt`; `tools/install_runpod.sh` (one-shot Linux/RunPod install). | Done |
| 3 | Other tools and models explained in the demo video | End card in `submission/DEMO_VIDEO_SCRIPT.md` lists every model and tool. Also in README → Credits and Models and licenses. | Script done; video TODO |
| 4 | Lawful, SFW, no unlicensed IP or likenesses | Previz figures are faceless; demo scenes are generic (riders, cars, a flashlight search). 3D models are CC0 (Quaternius). Style and lighting presets are written in our own words and use no stills or real likenesses (`THIRD_PARTY_NOTICES.md` → Data). All models are used under their published licenses. | Done; re-check the final video |
| 5a | GitHub repo with app code, workflow files, license, local run instructions | This repo: code (`soundstage/`, `web/`), workflows (`example_workflows/`), `LICENSE`, `README.md`. | Push TODO |
| 5b | Demo video, 2 minutes or less | Script: `submission/DEMO_VIDEO_SCRIPT.md` (1:55). | Record TODO |
| 5c | Optional link to try it | App demo https://claude.ai/artifact/GwtC3yFZtGCsTsiPGbvnAq and stage-only page https://claude.ai/artifact/U9dJ7h8s6tL1Tq8bAvWkpc (in README → Try it). | Share publicly TODO |
| 5d | Social post linking the demo video with #OpenSourceHiggsfield | Drafts: `submission/SOCIAL_POST.md`. | Post TODO |

## TODO before the deadline (human)

1. **GitHub username.** Replace `theboord` in `README.md` and `pyproject.toml` with the real account name.
2. **Create the repo and push.** Create an empty public repo `ComfyUI-Soundstage` on GitHub (no README or license, they are already here), then:
   ```bash
   cd ComfyUI-Soundstage
   git add -A && git status        # check nothing unexpected is staged
   git commit -m "Soundstage: initial public release"
   git branch -M main
   git remote add origin https://github.com/theboord/ComfyUI-Soundstage.git
   git push -u origin main
   ```
3. **Share the two artifact links publicly** (App demo and stage-only page), then open each one in a private window to confirm it loads.
4. **Record the demo video** from `submission/DEMO_VIDEO_SCRIPT.md`, keep it at 2:00 or less, and upload it (YouTube unlisted or public).
5. **Post on social** with the video link, the repo link and #OpenSourceHiggsfield (`submission/SOCIAL_POST.md`).
6. **Submit the form** with the repo URL, video URL, try-it link and post URL. If the form asks which Comfy surfaces were used, the App runs locally in App mode; `tools/soundstage_sdk.py` uses the Comfy SDK; ElevenLabs runs through ComfyUI partner nodes (optional).
7. Optional: review `docs/decisions.md`. It is the raw development log and mentions internal notes; trim it if you would rather not publish them.
