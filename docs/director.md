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
  dynamic / static / off, simulate and bake. World collisions ([world.md](world.md)): `ram` (*"the police car rams the
  red car into the boxes"*: the speed planned by momentum, the crash baked), `check` (the consequence check: anything
  passing through anything, in plain words with Crash them / Reroute fixes; it also runs before every render),
  `reroute`, `keep_keyed`.
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

## Decisions in the Director's Book

When a chat command changes the set, the Book keeps a decision note on the scene (`book.recordDecision`, in
`web/book/model.mjs`). Later commands read it back as "Decided earlier: ...".

- **What is kept:** the decision, not the chat. The note's `text` is a short summary the assistant wrote (`summary`),
  or, without one, the change in words, such as `Weather: rain; Lens: 50`. `change` holds the calls as
  `[{tool, args}]`. Only the argument keys listed for that tool in `DECISION_ARGS` are kept: numbers, enum values and
  one-word ids or names (`sh_2`, `mara`). A tool not in the list keeps no arguments.
- **What is not kept:** the user's typed sentence (`command`), or any piece of it. Free-text arguments (`note`,
  `text`, `what`, `at`, `value`, a description) and names of more than one word are always dropped. A summary that
  shares three words in a row with the sentence (two of them real words, not "to the") is dropped too. So is a
  joined value (`red_pickup_truck`, `gas-station-pumps`, `a.b:c`) that, split on its separators, repeats the
  sentence or two real words in a row of it; if the kept values still line up into such a run, only numbers and
  on/off values stay. The cost: an enum spelled out in the sentence (`low_angle` from "a low angle shot") is dropped
  from that decision. The sentence is used only to skip undo and play and to check the summary and values. The
  summary and the ref are also checked with the spaces taken out (NFKC, lowercase, soft hyphens and joiners removed,
  letters and digits only): `Done: makeitpourwithrain` or a ref `:makeItPourWithRain` is dropped too.
- **Older notes:** decision notes written before 2026-11-07 held the typed sentence. On load they are rewritten to
  the tools they changed (for example `Move; Lens`) and keep their id. Notes from the first 2026-11-07 version
  (`dv: 2`) are cut to the allowed arguments and their text is written again from the change. The new text reaches
  the server copy on the Book's next save.
- **Older notes on the server (known limit):** that rewrite happens only in the open Book, on load. Every other
  stored copy saved before it (`projects/<P>/autosave/*.json`, `projects/.trash/*/workflow.json`, another project's
  `workflows/<P>.json`, a book in the books folder) keeps the typed sentence until it is forgotten or migrated.
  `await book.legacyDecisions()` (`POST /soundstage/book/legacy`) lists them machine-wide:
  `{ok, decisions: [{id, ref?, project_id?, project?, files}], files}`. Each can be forgotten by id or ref. `await
  book.legacyDecisions({apply: true})` (`{apply: true}`) rewrites them all in place to the tools and number / on-off
  arguments only (no string survives, a stricter cut than the load rewrite), `dv: 3`, `migrated: true`, keeping
  the id and an opaque ref (a non-opaque old ref is dropped). It runs only when called: nothing runs it on startup.
- **Notes Ask adds (`book.addNote(text, {source: "ask", ref})`):** the note keeps `text` as given, so Ask must pass
  a short summary it wrote, never the user's typed sentence (needs Ask's side, `web/agent/`). `ref` is kept only
  when it is an opaque `${projectId}:${turnId}` that does not spell the text. `forgetDecision(id or ref)` and the
  server scrub remove `source: "ask"` notes as they remove decisions; `POST /soundstage/book/note` takes `ref` too.
  Notes Ask added before 2026-11-07 have no ref: forget them by note id (their raw text stays in older stored copies
  until then; `legacyDecisions` does not list them, as they are not decisions).
- **Link id:** `recordDecision({..., ref})` stores `ref` only when it is an opaque `${projectId}:${turnId}`
  (`DECISION_REF_RE` in `web/book/model.mjs`: `p_` + 8 hex or empty, a colon, then 1-48 of `A-Z a-z 0-9 _ -`).
  Anything else is dropped and the note has no ref: chat text, a sentence, or a turn id that spells out the typed
  words (`make_it_rain`). `forgetDecision(ref)` removes every decision note with that ref.
- **Forget:** `await book.forgetDecision(id)` (a decision, source `chat`, or a note Ask added, source `ask`; never
  the director's own notes or Pitch's) removes the note from the open Book and the workflow
  (`node.properties.ss_book`), and saves the Book. It then calls `POST /soundstage/book/forget {ids, project: {id,
  name}}`. That call removes the note from every stored copy of that project on the server:
  - the books folder (`user/default/soundstage/books/*.json`, and leftover `*.json.tmp`)
  - the user's `workflows/*.json`
  - `projects/**`: manifests, the 20 autosaves and the trash
  - `output/soundstage_projects/<P>/`: collected copies (`script/directors_book.json`, and `project.json`'s `book`
    and `workflow`). A collected folder is the project's when its name is the project's folder name or its
    `project.json` names the project; another collected folder holding the same note is in `other_copies`.

  A file belongs to the project when it carries the same project id, or no id and the same project name, or sits
  anywhere inside `projects/<project name>/` (a library Rename moves an old project's autosaves, which still name the
  old project), and so does `workflows/<project name>.json` whatever id it carries (two tabs saving at once can leave
  it with another id). Another project's file is left alone and listed in `other_projects`. When it holds a copy of
  the same decision (the same note id: a Duplicate, a Save As copy) it is also listed in `other_copies` and `ok` is
  `false`. `book.scrubDecision(id, {everywhere: true})` (body `everywhere: true`) removes those copies too, by note id
  only: another project's own decision that merely shares the ref is never touched. A file is rewritten only if its
  text holds the id. `ok` is `false`, with an `error` line, when a copy was not cleaned: a file over 64 MB
  (`skipped`), a file that names no project (`skipped`), a file whose text still mentions the id, for example inside
  a string (`still_mentions`), or another project's copy (`other_copies`). Without a project only the open book is
  cleaned, and the answer says so.
- **A note not in the open Book** (dropped by the 40-decision cap, another tab's, or one already removed locally):
  `forgetDecision(id)` still runs the server scrub. It answers `{ok: true, in_book: false, copies}` when stored
  copies were removed, and `{ok: false, in_book: false, copies: 0, error}` when nothing was left to remove (or the
  scrub failed). `await book.scrubDecision(id)` does the same scrub without looking at the Book.
- **What `ok: true` covers:** only the server-side files listed above. Not other open tabs, ComfyUI canvas undo,
  browser storage, ComfyUI's queue history (`extra_pnginfo`), metadata inside rendered files, or a collected zip
  already downloaded.
- **Written back:** a second tab with the same project open, or ComfyUI's canvas undo to a step before the Forget,
  still holds the note. Its next Save or autosave writes it back to the server. Forget again after closing it.

**Copies that Forget does not reach** (Soundstage does not change ComfyUI itself):

- **ComfyUI's queue history:** each queued prompt keeps the whole workflow in `extra_pnginfo`, Book included. It
  lives in the server's memory until ComfyUI restarts or its queue history is cleared.
- **Rendered files:** PNG and video metadata embed the workflow as it was when they were rendered.
- **The browser:** the frontend keeps the open workflow and its in-tab undo steps in browser storage. The Director's
  own Undo list holds the typed command in memory until the page reloads.
- **A collected zip already downloaded** (the folder in `output/soundstage_projects/` is cleaned, the zip is not).

From 2026-11-07 a decision note no longer holds the typed sentence, so these copies hold only the short summary and
the change.

