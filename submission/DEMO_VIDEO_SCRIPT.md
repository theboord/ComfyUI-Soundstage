# Demo video script (1:55)

A plain screen recording of ComfyUI in App mode. Editing is not judged: show the click, then the result. Load `example_workflows/Soundstage_Western.json` before recording and have the Frame and Motion renders already done for every shot, so Run steps can cut straight to the result. Keep a short title card and the end card.

| Time | Beat | On screen (click → result) | Voice-over / caption |
|---|---|---|---|
| 0:00–0:05 | Title | Card: "Soundstage: a film set in ComfyUI". | "Soundstage is a ComfyUI node pack and App. Block it in 3D, render it with open models." |
| 0:05–0:12 | Open | Workflows → Soundstage_Western → switch to **App** mode. Step bar shows Set, Frame, Motion, Review, Deliver. | "One App, five steps." |
| 0:12–0:35 | ① Set | Orbit the stage. Add "horse" and "cowboy". Drag the cowboy onto the horse: he mounts. Scrub the playhead: the horse gallops. Click **+ Shot** twice to add a wide and a close-up; click each shot tab to show its framing. | "Set: cast, horses, light and cameras. Drag a person onto a horse to ride it. Add as many shots as the scene needs." |
| 0:35–0:50 | ② Frame | Click **Frame**. Show the clay frame for each shot, press **Run**, cut to the Krea 2 first frame for each shot. | "Frame: Krea 2 paints the first frame of every shot, steered by the stage's depth." |
| 0:50–1:08 | ③ Motion | Click **Motion**, press **Run**, cut to the LTX video for each shot playing with sound. | "Motion: LTX-2.5 Layout-to-Render animates every shot with sound, following the blocking and the camera." |
| 1:08–1:20 | ④ Review | Click **Review**. Drag the Ladder wipe across one shot: clay → frame → draft → final. | "Review: wipe between every rung of every shot." |
| 1:20–1:35 | ⑤ Deliver | Click **Deliver** → Cut. Press play on the cut. Click **Cut → one video** → the single video plays. Flash the Layer Pack folder and the NLE export menu. | "Deliver: the cut as one video, a Layer Pack for VFX, or an EDL/XML for your editor." |
| 1:35–1:45 | In the car | Open Soundstage_In_The_Car. Select the car → In-car camera → **＋ All interior shots**. Four interior shots appear in the shot row. | "In a car, one click adds every interior angle." |
| 1:45–1:55 | End card | Static card (text below). | "Everything here is open and runs locally. Repo and try-it link below." |

## End card text (requirement 3: every tool and model used)

```
Soundstage, built with ComfyUI (App mode)
Models: Krea 2 Turbo + Krea 2 depth-control LoRA · Qwen3-VL 4B
        LTX-2.5 22B + Layout-to-Render IC-LoRA · Gemma text encoder
        SAM 3.1 · BiRefNet · Qwen3.5 4B (scene agent, optional)
        Chatterbox / ElevenLabs via partner nodes (optional audio)
Nodes:  ComfyUI-LTXVideo · comfyui-krea2-controlnet
Web:    three.js · Spark · Quaternius CC0 models · Lucide · Space Grotesk
Ran on: NVIDIA RTX 6000 Ada 48 GB (RunPod)
Code:   MIT · github.com/theboord/ComfyUI-Soundstage
#OpenSourceHiggsfield
```

## Recording notes

- 1920×1080, browser zoom so the step bar and shot row are readable.
- Do not show tokens, the RunPod console, file paths with your username, or any other project.
- If any tool not in the end card shows up on screen (for example a screen recorder overlay or an editor), add it to the card or crop it out.
- Check the length is 2:00 or less after export.
