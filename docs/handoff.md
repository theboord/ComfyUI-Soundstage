# Hand-offs: Open in ComfyUI, and Film a move on your phone

✦ One-click › **Hand-off**. None of these use the GPU.

## Open in ComfyUI · Download the graph

Every take and still the App saves already holds the exact graph that made it. ComfyUI's SaveVideo and SaveImage write the queued API prompt (the `prompt` tag) into the file. When the graph was queued from a canvas, they also write the UI workflow (the `workflow` tag). Soundstage also adds its own recipe (the `soundstage` tag, see `takecheck/recipe.py`).

- **Open in ComfyUI** reads those tags (`GET /soundstage/handoff/workflow?ref=sub/name.mp4 [output]`). It opens the graph as a **new workflow tab**: the UI workflow through `app.loadGraphData`, or an API prompt through `app.loadApiJson`. The App's own tab is not touched. Nothing re-renders.
- **Download the graph** saves `<take>.workflow.json` and/or `<take>.api.json`.
- MCP: `soundstage_take_workflow {ref, save_to?}`.

Known limits:

- The App queues most of its renders as API prompts, so most takes carry only the API graph. That graph opens with ComfyUI's own auto layout, not a hand-arranged canvas.
- A take rendered from a stored stage (`stage_ref`) restores its set only on the server that rendered it. This is the same rule as recipes (tools/qa/README.md).
- A file whose tags were stripped by re-encoding outside ComfyUI says so ("no ComfyUI graph inside").

## Film a move (phone → App)

The phone viewfinder (`/soundstage/vcam/viewfinder`, docs/vcam.md) has a **Film** button. It records a real clip with the phone's own camera and microphone (MediaRecorder: MP4/H.264 on iPhone, WebM on Android), at most 60 s and 300 MB. It sends the clip to the computer as one of three things:

| Send it as | Lands in |
|---|---|
| Capture motion | SAM 3D Body copies the movement onto the selected person on the set (the same as Import video › Capture motion) |
| Real performance | The "Use a real performance" dialog for the selected character, with the clip already loaded. Tick consent and name the performer, then Read the performance |
| Footage | ⑤ Motion › Ripple edit with the clip (keep the real footage; Recast from there) |

How it works:

- The desktop mints a **clip code** (`POST /soundstage/vcam/clipcode`, valid for 6 h). Both QR codes carry it: Phone viewfinder and ✦ › Send a move from your phone.
- The phone uploads to `POST /soundstage/vcam/clip?code=…&dest=…` (the raw video body). Without the code the upload is refused. The server streams it to disk with a 300 MB cap, converts it to a constant-30 fps H.264/AAC MP4 in `input/soundstage_private/phone/`, and announces a `clip` event. The App fetches the clip and brings it in.
- The LAN bridge (`tools/vcam_bridge.py`) lets `POST /soundstage/vcam/clip` through, and nothing else new. Only the desktop can mint codes.

Known limits:

- **It needs https.** Phones refuse the camera on a plain-http page, so Film works through the bridge's https address. On http the button explains this instead of failing.
- The clip is converted to 30 fps on arrival. Phone slow-motion (120/240 fps) is lost.
- Real performance needs a character selected (else the first person on the set). Consent is still ticked by hand in the dialog, on purpose.
