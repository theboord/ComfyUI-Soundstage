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

## MCP

The same tools are an MCP server for Claude Desktop / Code: see [mcp.md](mcp.md).
