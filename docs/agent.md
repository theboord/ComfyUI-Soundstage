# Scene agent: describe it, then direct it by chat

Type a scene ("rainy night, detective alone in his office") and the stage builds it: set, cast on marks, props, time of day, film lights, and 1–4 camera setups from the Director's Advisor. Then edit by chat ("add a second detective by the window", "give me an over-the-shoulder on the woman"). Every edit is a small list of undoable ops.

The local model (Qwen3.5-4B via core `TextGenerate`, the same graph as the object designer) only *names* things: set, time, weather, cast, props, blocking. Rules do all placement, lighting and cameras. If the model is missing, busy or answers nonsense, the rules backend answers alone, so a call always returns a loadable scene.

**Measured on the pod (RTX PRO 6000, ComfyUI 0.43):** the model answers a build prompt in about 3 s warm and about 30 s cold (first load). Rules, placement, the advisor and validation add under 0.1 s.

## Files

| Path | What it is |
|---|---|
| `web/agent/agent.mjs` | `SceneAgent` (describe / edit / undo / redo / prop design), `applyOps(stage, ops)`, `applyOpsToScene(scene, ops)`, `inverseOf(ops)`, `runLocalModel(api, …)` |
| `soundstage/agent/catalog.py` | Python mirror of the stage: library kinds and footprints, set bounds, obstacles and named places, time presets (sun math ported), light types |
| `soundstage/agent/location.py` | Any set from a sentence: words → a composed location (a preset or a room at any size, its colours, real-size dressing, practical lights); `relocate()` changes the set of an existing scene and keeps what was placed |
| `soundstage/agent/plan.py` | Text → plan with rules; LLM answer parsing and repair; merging the two |
| `soundstage/agent/build.py` | Plan → full scene: blocking patterns, furniture with the blocking, dressing out of the camera's sight line, lights |
| `soundstage/agent/cameras.py` | Advisor coverage → stage shots (`camera_keys`); single setups on demand (OTS, single, insert, POV, two-shot, wide) |
| `soundstage/agent/validate.py` | `validate_scene()` repair; `check_scene()` residual problems |
| `soundstage/agent/ops.py` | Symbolic ops → concrete undoable ops; `apply_ops()`; rules command parser |
| `soundstage/agent/prompts.py` | The two system prompts and the user-message builders |
| `soundstage/agent/core.py` | `describe()` / `edit()`, shared by routes, nodes and tests |
| `soundstage/agent/routes.py` | HTTP routes, `register()` |
| `soundstage/agent/live.py` | CLI and live client against a running ComfyUI |
| `soundstage/nodes_agent.py` | `NODES = [SoundstageSceneAgent, SoundstageSceneEdit, SoundstageSceneBrief]` |
| `tests/test_agent.py`, `tests/test_any_set.py`, `tests/js/agent.test.mjs`, `tests/agent_fixtures/ops_parity.json` | Python and JS tests (20 any-set prompts in `test_any_set.py`) |

## Integrator wiring

1. **Routes** (root `__init__.py`; idempotent):
   ```python
   try:
       from .soundstage.agent import routes as _agent_routes
       _agent_routes.register()
   except ImportError:
       pass
   ```
2. **Nodes:** add `"nodes_agent"` to the module list in `SoundstageExtension.get_node_list()`.
3. **Widget** (`web/soundstage.js`): a "Describe" text box and a chat box with Undo/Redo.
   ```js
   import { SceneAgent } from "./agent/agent.mjs";
   const agent = new SceneAgent({ api, stage, onStatus: (m) => (status.textContent = m) });
   describeBtn.onclick = () => agent.describe(describeInput.value);
   chatInput.onkeydown = (e) => { if (e.key === "Enter") agent.edit(chatInput.value); };
   undoBtn.onclick = () => agent.undo();
   redoBtn.onclick = () => agent.redo();
   ```
   `onLoad(scene)` fires after every scene the agent loads: build, edit, undo, redo and designed props.
   - `loadScene`/`applyOps` already call `stage.onChange(stage.toJSON())` and `stage.onShots()`.
   - Controls refreshed only by `syncEnv()` (Set, Weather) need this hook, or need `syncEnv()` added to the Stage onChange callback.

   Options: `useModel: false` gives rules only (instant, no GPU). `designProps: false` keeps placeholder boxes. `modelTimeoutMs` (default 60 s) sets when to give up on the model and use the rules. `agent.history` holds the chat transcript.

### Stage API used (public only)

The agent uses `stage.toJSON()`, `stage.load(scene)`, `stage.frame`, `stage.setFrame(f)`, `stage.selected`, `stage.select(id)`, `stage.onChange(scene)` and `stage.onShots?.()`.

`applyOps` takes `toJSON()`, applies the ops to that copy, then calls `load()`. It restores the playhead and selection, then fires `onShots` and `onChange`. Nothing private is touched. Scenes include `camera`, `camera_end` and `camera_keys` because `load()` requires `camera`.

## HTTP API

| Route | Body | Returns |
|---|---|---|
| `GET /soundstage/agent/info` | | `{model, available, max_length}` |
| `POST /soundstage/agent/prompt` | `{mode:"build", text, genre?}` or `{mode:"edit", command, scene}` | `{system, prompt, max_length, model}`: feed it to TextGenerate |
| `POST /soundstage/agent/build` | `{text, genre?, llm_text?}` | `{scene, plan, notes, backend, designs:[{id,name}], ms}` |
| `POST /soundstage/agent/edit` | `{scene, command, llm_text?}` | `{ops, inverse, scene, symbolic, summary, notes, backend, ms}` |
| `POST /soundstage/agent/validate` | `{scene}` | `{scene, notes}` |

The browser flow is `prompt` → model through `/prompt` → `build`/`edit` with `llm_text`. Without `llm_text`, the server uses the rules.

`designs` lists props the library lacks. They arrive as one-box placeholders (`kind:"custom"`, `recipe.placeholder:true`, `design:"jukebox"`). `SceneAgent` then asks the object designer for each one, one at a time; cached designs are instant. It swaps each recipe in with an `update_object` op.

## Scene output

Everything placed goes in `actors[]`, because the stage renders `props[]` only on the plaza:

```
{id, name, kind, role?, position:[x,0,z], keys:[{frame, position}], height_m, rotation_deg, recipe?, design?}
```

Shots look like this:

```
shots[] = {id, name, setup, camera_keys:[{frame, position, target, focal_mm}], why, lens_mm, movement}
```

`agent: {prompt, plan}` is kept for context. Units are metres, Y is up, 24 fps, and the scene runs 97 frames. A move is a key at frame 0 plus a key at frame 96.

**Riders and pass-bys:**
- "a cowboy on a horse", "a woman riding a bicycle" or "a man in a car" becomes one rider and one host. The rider gets `mount_id` and a `pose` (the stage's `MOUNTS`: ride, cycle or sit) and mirrors the host's keys. No second horse is created; a separate horse in the model's cast or props is folded into the mount.
- Anyone who "rides/walks/drives past, through or across" gets a path. It crosses the frame from screen-left to screen-right, downstage of the others. On a mount, the path goes on the host.
- "standing by a police car" puts that vehicle right behind the group, side-on. Dressing is kept off a mover's path.

**Camera intent from the text:**

| Words | Effect |
|---|---|
| (default) | Wides at 1.5 m |
| "low", "low angle" | Wides at 0.6 m; singles 0.5 m under the eyeline |
| "high angle" | Wides at 3.4 m, still no steeper than 38° |
| "overhead", "bird's eye" | Overhead allowed |
| "tracking", "following" | Wides move with the mover |

- Wides and two-shots are recomposed so everyone fits the lens FOV horizontally, square on to the line between the two who stay put.
- Every camera is pitch-limited, pushed back rather than looking straight down.
- A shot whose subject moves always travels with them.
- A moving character with no shot of their own gets a "Tracking single".

**Blocking patterns:** alone (at a desk if there is one), face_off (12 m apart, facing), across_table (table between them), side_by_side, walk_and_talk, group (in front of the couch, facing the audience side), chase (moving keys), rescue (rescuer swims to the victim).

**Cameras:** the advisor's shot list (recipe, size, lens, height, move) is converted to keys. A/B are ordered so the coverage side is −Z, the open side of the interior and tank sets. A lone actor's coverage is rotated to the way they face. Cameras that would sit inside a wall are pulled toward their target, and the lens is narrowed to keep the framing. Duplicate setups are dropped.

## Any set from a sentence

The 20 stage sets are presets: quick starts. `location.compose(text)` reads any place from the words and composes it:

- **Base:** a preset when the words name one more specifically than anything else (reef, train carriage, runway); else a **room at any size** (the stage's interior set built at `environment.room = [w, d, h]`; sizes from "6 by 4 metres", "30 x 20 ft", "with a 2.4 m ceiling", or the place's own size scaled by "tiny"/"small"/"large"/"huge", clamped to 1.6–60 m wide, 1.6–80 m deep, 2–12 m high); else open ground (`empty`, desert, forest, a street...) re-coloured.
- **Look:** floor, wall, ceiling, window and door colours (`environment.look`, hex), from the place and its era (1920s, 1950s, 1970s, 1980s, Victorian, medieval, western, futuristic, modern, abandoned). The stage paints the room and the ground with them.
- **Dressing:** about 50 places (diner, bar, office, prison cell, courtroom, church, warehouse, gym, hospital, bus, subway car, starship bridge, throne room, cave, farm, graveyard, campsite, trench, Mars...), each a list of pieces with real sizes, colours and where they go (back wall, side walls, rows, an aisle, pillars, scattered, along the kerbs). Library kinds are used where they fit (table, chair, car, tree, rock, wall, crate...); the rest are built from boxes and cylinders at real size (a booth is seats, backs and a table; a pew is a seat and a back). Anything that is only one box carries `recipe.placeholder` (the object designer may detail it) and the notes name it. Pieces are placed with `space.free_spot` around what is already there, never overlapping, and out of the master camera's view of the cast; what doesn't fit is named ("No room for: 2 x booth").
- **Light:** time and weather from the words, else what the place implies (a nightclub is at night, a graveyard foggy); practicals the place has (pendant lamps, fluorescent panels, neon, a chandelier, candles, firelight) as film lights with `from_location: true`.

Every piece carries `set_dressing: true`, and so does scene-type dressing the words didn't name. `environment.location = {label, place, era, source, prompt, approximations}` says what was built.

**Changing a set** (`{"op": "location", "describe": "..."}`, from "make it a 1950s diner at night", "turn it into …", "set it in …", "set: …", or the Director's `location` tool, or **Build set** in the Set step): the old dressing and its lights are removed, the new set, look, dressing and lights come in, the time and weather from the words are applied, and every other actor stays (moved to the nearest free floor only if it would now stand in a wall). An era alone ("make it 1920s") restyles the current place. The whole change is one undo. Picking a preset (`set` op or the **Start from preset** menu) clears `room`, `look` and `location` and keeps everything on the stage.

## Ops (undo-friendly)

The model writes **symbolic** ops, by name with no coordinates:

```
move{target, near | dir+amount | away_from}  add{what, near}  remove{target}  rotate{target, face | deg}
scale{target, factor}  time{preset}  weather{weather}  set{set}  light{type, on}  remove_light{type}
shot{setup: wide|two_shot|single|ots|insert|pov, on, over, focal?}  camera{move: push_in|pull_out|higher|lower|wider|tighter, focal?}
mount{target, on}  dismount{target}  location{describe}
```

The server resolves these into **concrete** ops. Each concrete op carries `undo`, and `inverse = [op.undo for op in reversed(ops)]`.

| op | undo |
|---|---|
| `add_object {object, index}` | `remove_object {id}` |
| `move_object` / `rotate_object` / `scale_object` / `update_object {id, set}` | same op with the old field values |
| `set_environment {set}` | old values (`null` removes a field, so undoing a new `room` leaves no trace) |
| `set_lighting {set, sun}` | old values and old sun |
| `add_light {light}` | `remove_light {id}` |
| `add_shot {shot, index}` | `remove_shot {id}` |
| `update_shot {id, set}` | old values |
| `set_active_shot {id}` | previous id |

Resolution keeps the set valid:
- Moves go to the nearest free spot.
- A resized object that grows into a neighbour gets moved.
- Changing the set relocates anything that no longer fits and pulls cameras inside.

`applyOpsToScene` (JS) and `apply_ops` (Python) are mirror implementations. The parity fixture is replayed by both test suites.

When the model answers, its ops are preferred. The rules parser's ops win only when the model's ops resolve worse, for example names that aren't on set.

## Prompt templates

Both prompts live in `soundstage/agent/prompts.py`. Each is under 2 KB and has one example; the example is deliberately not one of the test scenes.

- **Build** (`max_length` 260): returns `{"set","time","weather","genre","cast":[{"name","kind"}],"props":[…],"blocking","lights":[…],"shots"}` from enums, with no coordinates and no hand props. User message: `Scene (genre): <text>`.
- **Edit** (`max_length` 200): the op vocabulary above plus one example. The user message is a short scene context followed by the command:
  ```
  Set: interior, time: night, weather: rain
  On set: Detective (man), Desk (table), Filing Cabinet (filing cabinet)
  Places: window, door, back wall, left wall, right wall, corner
  Shots: Wide (EWS)*, Insert (INSERT)
  Command: add a second detective by the window
  ```

Repairs applied to the model's answer:
- Code fences, `<think>` blocks, trailing commas and truncated JSON are fixed.
- Unknown enums fall back through keyword mapping ("high noon" → midday, "Main Street" → street_night).
- Hand props (guns, hats, cups…) and people listed as props are dropped.
- An interior "lamp" becomes a floor lamp, not a 4 m street lamp.
- Thin prop lists are topped up from the rules dressing.

## Running it

```bash
python3 -m pytest tests/test_agent.py -q
```

```bash
node --test tests/js/agent.test.mjs
```

```bash
python3 tests/test_agent.py --write-fixture
```

Regenerate the fixture with the last command after changing op semantics.

```bash
python3 -m soundstage.agent.live build "first date in a 50s diner"
```

```bash
SOUNDSTAGE_AGENT_OUT=/tmp/scene.json python3 -m soundstage.agent.live build "rainy night, detective alone in his office"
```

```bash
python3 -m soundstage.agent.live edit /tmp/scene.json "add a second detective by the window"
```

## Limitations

- **Composed sets are clay blocks.** A booth is five boxes and a post; a jukebox or a pie case is one box at its real size until the object designer details it. Rooms are rectangles open on −Z (no L-shapes, no second room; use a floor plan for those), with one window and one door on the back wall.
- **A set change replaces dressing you moved.** Pieces the composer placed are `set_dressing`; if you moved a booth by hand and then say "make it 1920s", the booth is rebuilt where the composer puts it. Things you added yourself always stay.
- **Approximations:** a bus or subway car is a room with seats (no street outside the windows), a mountain is the desert's dunes in snow colours, another planet is the desert re-coloured under Earth's sky, a cave has flat rock-coloured walls. The notes say so each time.
- **Pitch mode** still picks from its own short list of places (street, room, forest...); describe the set in the Set step or by chat for anything else.
- **The stage has no vertical placement.** Everything stands on y=0, so nothing sits on a table (a desk lamp becomes a practical light), swimmers stand on the tank floor, and there is no seated pose.
- **Rooftops** use the `empty` set plus designed rooftop dressing. There is no roof edge or drop.
- **The plaza building** comes from `props[]`. Switching to the plaza by chat from another set does not re-create it; describe a plaza scene instead.
- **Blocking is one of eight patterns.** Unusual geography ("she hides behind the counter while he searches") gets the closest pattern; refine it by chat.
- **Forest trees are random set dressing.** The agent keeps the action in the clearing but does not know where each trunk is.
- **Model throughput:** model calls queue behind other ComfyUI jobs. A long video render delays the answer, and after `modelTimeoutMs` the rules answer instead. A server restart drops the job; the browser times out and falls back to the rules, and the CLI raises immediately.
- **Coverage is the advisor's recipe**, trimmed to 4 setups. Chat-added shots follow the −Z side of the line but are not re-checked by the Coverage Doctor.
- **Name matching is word-based.** "the tall one" won't resolve. Use names, kinds or roles ("the second detective", "the woman", "Hatch").
