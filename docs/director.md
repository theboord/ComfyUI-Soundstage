# The Director: talk to the set

A director who doesn't want to learn the controls can just say what they want. Open the **Director** panel (top bar,
or press <kbd>/</kbd>), type or hold a key and talk:

- "Put Mara in the sports car at night, rain, camera on the hood, she's nervous"
- "Make shot 2 a slow push-in at 50 mm"
- "Drop a crate stack by the wall and have the car crash through it"
- "Use the J-turn stunt"
- "Make the first frame warmer"
- "Render a draft of shots 1 to 3"
- "Cut it together with the best takes"

It answers with a short plan ("I'll put Mara in the sports car · move the clock to night · bring in rain ..."). Press
**Apply** (or Enter, or say "yes") and each step runs through the App's own controls, so you see the stage change.
Every turn has **Undo this**: the scene, the look, approvals and the cut all go back. Talk-through mode (on by default)
adds one line on why it matters in film terms, and suggests the next step as buttons ("Render a draft of shot 2").

**GPU work always asks.** Painting frames and rendering drafts or finals show "This uses the GPU" and wait for Apply,
unless you said "go" ("render a draft of shot 2, go"). "Go to scene 2" is not a "go".

## Keys

| Key | |
|---|---|
| <kbd>/</kbd> | open the panel, cursor in the box |
| <kbd>Enter</kbd> | send; on an empty box, apply the plan |
| <kbd>Esc</kbd> | cancel the plan, then close the panel |
| hold <kbd>`</kbd> | talk, anywhere in the App (let go to send) |
| hold <kbd>Space</kbd> | talk, in the empty box or while the panel is open (outside text fields) |
| <kbd>Shift</kbd>+<kbd>P</kbd> | Pitch Mode on / off (the mic stays on; see below) |

## What it can do (the tool layer)

33 typed tools, defined once in `soundstage/agent/director.py` (`TOOLS`), validated on the server against the live
scene, run in the browser by `web/agent/director.mjs`:

- **Set and cast:** add, stack (crates, boxes, barrels), move, remove, turn, scale, mount / dismount (people into cars,
  onto horses, into seats), set, time of day, weather, film lights.
- **Camera:** pick a shot, lens (mm), animated moves (push in, pull out, truck, crane, orbit, lock off, at a slow /
  medium / fast speed), rigs (tripod, dolly, steadicam, handheld, drone...), camera on a vehicle (hood mount, driver
  POV, passenger, back seat, dashboard, tracking alongside, overhead), new coverage setups, nudges.
- **Action:** car stunts (reverse J-turn, donut, handbrake 180), drive a vehicle straight through something, physics
  dynamic / static / off, simulate and bake.
- **Performance and look:** a note for an actor ("nervous") that goes into the frame prompt; the grade (warmth,
  contrast, saturation, grain, halation, vignette).
- **Production:** go to a script scene, paint first frames, render drafts or finals, approve / needs changes / reject a
  take, cut the scene together with each shot's best take, play, undo, build a new scene from a description.

Scene edits reuse the Scene agent's concrete ops (`ops.py`, each with its own undo); everything else calls the same
methods the panels use (stage.mount, setCameraFollow, applyStunt, simulatePhysics, the ⑤ Motion render, the approval
store, the cut). A call that names something that isn't on the set, a number out of range or an unknown tool is
dropped with the reason ("couldn't: nothing called 'unicorn' on set") and never runs.

## The model

| Backend | |
|---|---|
| **Local Qwen3.5 4B** (default) | `text_encoders/qwen3.5_4b_bf16.safetensors`, the same file as the object designer, run through ComfyUI's queue (core TextGenerate, offline). It waits behind a render that is already running. |
| **Ollama** | any model in an Ollama on the computer running the browser (`http://127.0.0.1:11434`); it answers while the GPU renders. |
| **Rules** | no model: the App's verbs, numbers and names by pattern. Also the fallback whenever a model answer is unusable. |
| **API model** | opt-in, hidden unless ComfyUI runs with `SOUNDSTAGE_PARTNER_MODELS=1` (like partner models): any OpenAI-compatible URL with your own key, which stays in the browser tab. |

The model only writes JSON tool calls (`{"calls":[{"tool":"lens","mm":50}, ...]}`), never coordinates. The planner
compares its answer with the rules: the model wins when it covers at least what the rules found, and for the exact
verbs (renders, frames, shot numbers, lenses, stunts, approvals, the cut, scene numbers) the rules' reading of the
numbers is kept, because a 4B model often gets "shots 1 to 3" wrong.

## Voice

- **Browser speech recognition** where the browser has it (Chrome, Edge, Safari).
- **Whisper on the server**, offline: the panel records the clip, encodes 16 kHz WAV and posts it to
  `/soundstage/director/transcribe`; whisper-base (MIT, `models/whisper/whisper-base`) runs on the CPU so it never
  takes VRAM from a render. Pick it under the panel's settings.

Either way, "yes" / "apply" / "go" applies a waiting plan and "no" / "cancel" drops it, so a whole session can run with
no mouse.

## Pitch Mode: talk, and the set builds itself

Press **● Pitch** in the Director panel (or <kbd>Shift</kbd>+<kbd>P</kbd>) and pitch the scene out loud: "Night. A rainy
alley in Chinatown. A detective in a trench coat walks toward camera… a car's headlights sweep across him… he turns
and runs… camera follows low and handheld." The mic stays on; you don't press anything per sentence.

- **Beats.** The live transcript is cut into beats at each sentence, ellipsis or "then" (`chunkTranscript` in
  `web/agent/pitch.mjs`). Browser speech recognition gives words as you speak; Whisper (offline) listens in windows
  that end at a pause (0.45 s after 0.3 s of speech) or at 5 s.
- **The set builds itself.** Each beat goes to `/soundstage/director/pitch` (`soundstage/agent/pitch.py`): the pitch's
  words (set and place, time, weather, a character and wardrobe, what they do relative to the camera, a passing car,
  props, camera height / rig / follow / lens) become concrete scene ops, applied live. "He" and "she" mean the last
  person of that kind. This is instant (about 0.1–0.2 s a beat), so the GPU stays free for the sketches. Opt-in
  under ⚙ ("Pitch: the local model also reads each beat"): the local Qwen3.5 4B reads every beat too; the rules keep
  what they read and the model only fills what they missed (then the beat is re-staged and re-sketched). On a shared
  queue that costs 2–6 s a beat.
- **Whisper hears film words.** Each Whisper window is sent with a short list of film words and the last two beats as
  Whisper's prompt (`X-Soundstage-Prompt`), so "a rainy alley" isn't heard as a name. Windows that come back as one
  syllable repeated (Whisper on a cut word) are dropped.
- **A sketch per beat.** After each beat the camera view is captured (Color pass, 704 px) and a FLUX 3 Klein edit
  paints it in 4 steps at about 0.3 MP. The sketches land in the filmstrip under the transcript, so the pitch becomes a
  storyboard. A small HUD shows the last beat's latency: heard (transcription), plan, model, sketch, and sentence → image.
- **The queue is shared.** Pitch only ever deletes prompt ids it queued itself, and only while they are still waiting:
  the same beat's older sketch (re-staged or undone) and a backlog when you talk faster than the GPU paints (the newest
  two always render). A sketch already running is left to finish. It never presses Stop / interrupt. Sketches go to
  the front of the queue (they take seconds), but they still wait for a render that is already running: the HUD then
  says the GPU is busy and the set keeps building. Click a skipped beat to sketch it again.
- **Undo.** The whole pitch is one Director undo step; **Undo beat** takes back the last beat only.
- **Preview motion** queues a very fast, low-grade LTX-2.5 draft of the selected beat from its sketch (512×288, 49
  frames, one pass, no upscale or audio), at the back of the queue.
- **Lock it** turns the pitch into shots: one per beat (that beat's camera and rig), the transcript line as the shot's
  notes, and the sketch as its chosen first frame (through ④ Frame's "use as first frame"), ready for ④ Frame /
  ⑤ Motion. One undo step. The actors keep the last beat's blocking; each shot's first frame and notes carry its beat.
- **Style.** If the Director's Book is loaded, `host.getBookContext()` or `globalThis.SoundstageBook.getBookContext()`
  → `{style, intent}` is added to every sketch prompt.

## MCP

The same tools are an MCP server for Claude Desktop / Code: see [mcp.md](mcp.md).
