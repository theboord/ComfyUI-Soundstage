# Director's Advisor

The Advisor takes a scene description and returns a shot list. Each shot comes with its size, angle, lens, camera height, move, blocking and lighting, a reason it works with citations into the knowledge base, a 3D camera in stage coordinates, and compiled prompts. The default backend is rules only: it is deterministic, works offline and needs no GPU or model, so the demo never depends on an LLM.

## Files

| Path | What it is |
|---|---|
| `soundstage/cine_kb/*.json` | The knowledge base: 47 entries. 10 genres (incl. rom-com, multi-cam sitcom), 8 movements / national cinemas (incl. French New Wave, Korean thriller), 12 techniques named by what they do (incl. Spaghetti Standoff, three-way standoff, dolly zoom), 10 emotion recipes (incl. tension, intimacy, isolation), 7 coverage patterns (incl. chase / escape with "Mount up and ride off"). Every recipe, rule and avoid carries a why. |
| `soundstage/cine/schema.py` | KB entry and shot-list JSON Schemas (research/08 §7.4, extended), plus a dependency-free validator |
| `soundstage/cine/kb.py` | Loader, alias lookup, keyword retrieval. `python3 -m soundstage.cine.kb` validates every file |
| `soundstage/cine/scene.py` | Reads the scene text: intents, INT/EXT, time, weather, seated or standing, and a cast guess |
| `soundstage/cine/advisor.py` | `plan()` (retrieval, recipe choice, style blend, cast layout) and `realize()` (lens→distance, height→pitch, end camera for the move, measured blocking, 8k+1 frames, rationale) |
| `soundstage/cine/geometry.py` | Lens and camera math in the stage frame |
| `soundstage/cine/prompts.py` | Deterministic compilers: LTX paragraph, frame-1-only still prompt + negative, H3 block |
| `soundstage/cine/coverage.py` | Coverage Doctor checks |
| `soundstage/cine/llm.py` | Optional LLM composer (Ollama HTTP, or a draft from core TextGenerate) with repair and rules fallback |
| `soundstage/nodes_cine.py` | The four V3 nodes, exported as `NODES` |
| `tests/test_cine_*.py` | KB schema tests, the three sample scenes, Coverage Doctor negatives, LLM repair/fallback, node schemas |

## Registering the nodes (integrator)

`soundstage/nodes_cine.py` exports `NODES = [SoundstageAdvisor, SoundstageAdvisorBrief, SoundstageShotPrompt, SoundstageCoverageDoctor]`. `soundstage/nodes_stage.py` imports it automatically. The nodes import only `comfy_api.latest.IO` and the pure-Python `soundstage/cine` package. All four schemas pass the real V3 `Schema.validate()` (input and output ids are unique).

## Nodes (category "Soundstage")

**Soundstage · Director's Advisor** (`SoundstageAdvisor`, output node)
- **Inputs:**
  - `scene`: multiline text.
  - `beat`: optional, e.g. "tension rising to the draw".
  - Five pickers: `genre`, `movement`, `technique`, `intent`, `coverage`. Each takes `auto`, `none` or a KB entry, labelled `Name  [id]`.
  - `characters`: optional, one per line, e.g. `Cole: weathered gunfighter in a duster`. Line order sets A, B, C.
  - `max_shots`: 0 = the recipe's own length; otherwise keeps the first and last shots and samples between them.
  - `fps`, `preview_shot`.
  - `backend`: `rules` (default), `ollama` or `llm_draft`.
  - `ollama_model` (default `qwen3:4b`) and `ollama_url` (default `http://127.0.0.1:11434`).
  - Optional `stage_scene`: the stage's scene JSON. Actor positions and heights are then used for every camera.
  - Optional `llm_draft`.
- **Outputs:**
  - `shot_list_json`
  - `summary`: a readable table with the WHY and refs. It is also shown on the node.
  - For the preview shot: `camera3d_json`, which is `{"camera": {position, target, focal_mm}, "camera_end": {…}}`, the same keys as the stage's `DEFAULT_SCENE`.
  - Also for the preview shot: `ltx_prompt`, `still_prompt`, `still_negative`, `frames`.

**Soundstage · Shot to Prompt** (`SoundstageShotPrompt`)
- **Inputs:** `shot_list_json`, `shot` (1-based), optional `extra_detail` (wardrobe, a prop, a line of action).
- **Outputs:** `ltx_prompt`, `still_prompt`, `still_negative`, `h3_prompt`, `frames`, `camera3d_json`, `why`.
- It recompiles from the shot's fields, so if you edit the shot JSON the edits reach the prompts.
- The still prompt describes only frame 1 and states the head count. This follows the 2026-10-27 21:30 rule in decisions.md: give Krea the motion prompt and it draws the cast twice.

**Soundstage · Coverage Doctor** (`SoundstageCoverageDoctor`, output node)
- **Input:** `shot_list_json`.
- **Outputs:** `report`, an annotated `shot_list_json` and `passed`. `passed` is false only for a 180° or screen-direction failure.
- **Checks**, measured from the 3D cameras:
  - **180° line:** A→B, or a lone actor's eyeline. A crossing is legal after an on-axis neutral or a camera move across the line.
  - **Screen direction:** each character keeps facing the same side of the screen.
  - **30° rule:** consecutive shots of the same subject change angle, size or lens enough. Shots marked "jump" are allowed.
  - **Geography:** a wide comes before the first close-up.
  - **LTX timing:** frame counts are 8k+1, and a move gets at least 49 frames.

**Soundstage · Advisor Brief (for TextGenerate)** (`SoundstageAdvisorBrief`)
- Outputs `system_prompt` and `prompt`, built from the retrieved KB entries and the rules draft.
- Use it to run the composer on core ComfyUI:
  1. Wire both outputs into core **TextGenerate** with `qwen3.5_4b_bf16` loaded through CLIPLoader.
  2. Feed its `generated_text` into the Advisor's `llm_draft`.
  3. Set `backend = llm_draft`.

### LLM backends

The LLM only chooses, orders and explains the shots. Its JSON is repaired: enum synonyms are mapped ("push in" → `dolly_in`, "close-up" → `CU`), numbers are clamped, unknown KB refs are dropped and invalid shots are skipped. Geometry, frame counts, coverage checks and prompt wording are always recomputed by the rules code.

Any failure falls back to the rules recipe, and `notes[0]` says why. Failures include no server, a timeout, non-JSON output or zero valid shots. Tested live against the Ollama on localhost:11434 (`qwen3:4b`, Q4, probably on this Mac's CPU). All three runs timed out at 240-280 s, and each time the Advisor returned the rules plan with the reason in `notes`. The model answers a short prompt in about 6 s, so the bottleneck is the brief (~8k chars) on CPU. Two mitigations are in place: Qwen3's `/no_think` switch, because this Ollama build ignores `think: false`, and `num_predict` 2500. A successful LLM-composed run still needs the pod GPU, or core TextGenerate via `llm_draft`. The draft parsing and repair path is covered by the tests.

## In the app: Advisor tab (route + panel)

**Route** (`soundstage/cine/routes.py`, registered from the root `__init__.py` tuple as `cine.routes`):
- `GET /soundstage/advisor/vocab` returns `{genre|movement|technique|intent|coverage: [{id, label, summary}]}`, straight from the KB.
- `POST /soundstage/advisor` takes `{scene, beat?, genre?, movement?, technique?, intent?, coverage?, characters?, max_shots?, stage_scene?}`. Picks can be KB ids, picker labels, `auto` or `none`.
- The response is `{shots, recipe, picks, coverage: {verdict, warnings}, notes, cast, style, ms}`. Each shot has:
  - `name` (e.g. "4 · Extreme close-up A"), a stage `setup` id, and a one-line `summary`;
  - `purpose`, `why`, `kb_refs`, `alternatives`, `prompts` (ltx / still / still_negative / h3);
  - `camera_keys`: `[{frame, position, target, focal_mm}]` in stage metres, Y-up. Frame 0 always; frame `shot.frames - 1` too when the shot moves.
- With `stage_scene` (the live `stage.toJSON()`):
  - cameras are framed on the actors' frame-0 positions;
  - framing follows the delivery aspect in `shot.aspect`;
  - when the scene text says how many people there are ("a detective alone"), that count wins over the number of stage actors.
- Rules backend only, about 30 ms. Errors return `{error}` with status 400 (no scene) or 500.

**Panel** (`web/advisor/advisor.mjs`):
- Usage: `new AdvisorPanel(container, { api, stage, onStatus })`.
- Contents:
  - scene and beat boxes;
  - Genre, Movement, Technique, Intent and Coverage pickers, filled from `/vocab`;
  - a Max shots field;
  - **Suggest shots** (or Cmd/Ctrl+Enter).
- Each result card shows:
  - a clay thumbnail through that camera, from `stage.previewCamera` + `renderFrameTo("clay", 0)`, so it works while the stage viewport is hidden;
  - the one-line summary, the purpose, the why (click to expand) and KB-ref chips;
  - a tick box to include or skip the shot.
- **Add as setups** calls `stage.addShot(setup)` for each ticked shot, renames it, stores `shot.advisor = {why, kb_refs, prompts, …}`, then calls `stage.setCameraKeys(keys)`.
- "Replace earlier advisor setups" first removes only setups an earlier run added.
- The panel stops event propagation at its root, injects its CSS under `.ss-advisor`, and fits 340 px.

**Tests**:
- `tests/test_cine_routes.py`: run the routes through a real aiohttp server.
- `tests/js/advisor.test.mjs` (`node --test`): `addShotsToStage` against a stage stand-in, plus the live :8189 route. The live test skips while the route is not mounted.

## Coordinates (matches `web/stage/stage.mjs`)

- Y is up, units are metres, and actors stand on y = 0.
- Lens maths uses a 36 mm full-frame sensor width, with vertical FOV taken from the 960×512 frame (sensor height 19.2 mm). `vfov = 2·atan(19.2 / 2f)`.
- Distance comes from the size's frame height: `d = H · f / 19.2`.
- Default layout when no stage scene is wired:
  - A at (−s/2, 0, 0) and B at (+s/2, 0, 0), facing each other. C sits upstage at +z.
  - The spacing s is 14 m for a standoff, 1.15 m seated at a table, 1.0 m for intimacy and 2.2 m otherwise.
- Side A of the line is −z, the same side as the stage's default camera.
- Looking down +z, +x is screen-left, so a foreground face on side A lands on the right third. The dirty-single solver respects this instead of crossing the line.
- Each shot's `blocking.subjects[]` is measured by projecting each actor through that camera: `frame_position`, `facing` (screen-left/right/camera) and `screen_xy`. The prompts use these measured positions rather than template text.

## Example (rules backend)

```python
from soundstage.cine.advisor import advise, summary_text
sl = advise("Two gunfighters face off in a dusty street at noon. Neither will back down.")
print(summary_text(sl))
```

- **Picks (auto):** technique = Spaghetti Standoff, genre = Spaghetti Western (the technique's parent), intent = Tension.
- **Recipe:** "Two-man standoff, nine beats".
- **Shots:**
  1. EWS
  2. 50/50 WS
  3. cowboy A
  4. cowboy B
  5. dirty CU with the opponent sharp behind
  6. insert of the hand at the holster
  7. ECU of A's eyes with a slow push
  8. ECU of B's eyes
  9. WS for the draw
- **Rhythm:** shot lengths fall from 6 s to 1 s.
- **Coverage:** no line crossings. One warning: shot 7's push lasts only 33 frames, so generate 49 or more frames and trim.

```text
 1. EWS    establishing    24mm high/high    static        6.0s (145f)  the arena: the street with both men tiny at opposite edges
    WHY: The establishing frame answers 'where are we' so every later close-up can be placed in space. The high camera
    diminishes and surveils; the subject looks smaller and more exposed. The wide sets the stakes, cowboy singles show
    capability, the eyes show intention. The accelerating cycle (six seconds down to one) builds tension until the wide
    releases it with clear cause and effect. Rule: establish the whole arena and every duelist's position in one wide
    before any close-up, because tension needs geography: the audience has to know distances and lines of fire before
    it can fear the draw.
    refs: technique.spaghetti_standoff, emotion.tension, genre.western_spaghetti
```

Shot 7 in the JSON (abridged):

```json
{
  "shot_id": "7", "purpose": "ECU on A's eyes, the push barely moving", "subject": "A",
  "size": "ECU", "framing": "single",
  "angle": {"vertical": "eye", "horizontal": "front", "height": "eye", "height_m": 1.69},
  "lens": {"focal_mm_ff": 100.0, "look": "anamorphic", "dof": "shallow", "vfov_deg": 10.97},
  "movement": {"id": "dolly_in", "speed": "slow", "rig": "dolly"},
  "duration": {"seconds": 1.5, "fps": 24.0, "frames": 33, "start_s": 21.5},
  "camera3d": {"position": [-6.33, 1.69, -0.094], "target": [-7.0, 1.68, 0.0], "focal_mm": 100.0,
               "end": {"position": [-6.45, 1.688, -0.077], "target": [-7.0, 1.68, 0.0], "focal_mm": 100.0}},
  "rationale": {
    "why": "An extreme close-up turns a detail into an event; at this size a blink or a glance is a plot point. The push-in reads as realization or mounting pressure; the slower it is, the more inevitable it feels.",
    "kb_refs": ["technique.spaghetti_standoff", "emotion.tension", "genre.western_spaghetti"],
    "alternatives": ["Avoid handheld or shaky camera: the ritual needs stillness; motion belongs only to the draw."]},
  "prompts": {
    "ltx": "Exterior extreme close-up, a dusty street at noon. Hard noon sun, backlight, sun-bleached ochre and dust, sweat sheen, dust in the air. A gunfighter is in the centre of frame, facing the camera. Extreme close-up on the gunfighter's eyes, the push barely moving. The camera pushes in slowly; as the move completes, only the eyes fill the frame. Sun-bleached 1960s western look in 2.39:1 widescreen, hard overhead noon sunlight, dust hanging in the air, deep shadow under hat brims. Wind, spurs, silence; gunshot as release.",
    "still": "1960s spaghetti western film still, 2.39:1 widescreen, ... extreme close-up of the eyes of a gunfighter, a gunfighter in the centre of frame facing the camera, exactly one person in frame, eye level, 100mm lens, anamorphic, shallow depth of field ...",
    "h3": "[Shot 7] At 00:21.500, the camera cuts to an extreme close-up framing a gunfighter in a dusty street at noon ... The camera pushes in with small amplitude at slow speed."}
}
```

The other two sample scenes:
- **"A first date in a diner…"**
  - Recipe: emotion.romance's "First date in a diner booth", blended with the rom-com genre and the table-scene coverage.
  - Shots, all from seated height: 50/50 two-shot, matched 100mm singles, an insert of the fingers touching, the held look, and a tight two-shot push.
- **"A detective alone in a rain-soaked office at night…"**
  - Recipe: emotion.isolation's "Alone in the office at night", with Film Noir as the style layer.
  - Shots: an empty-office EWS, a wide at the desk, a phone insert, a profile MS, the window from behind, and a slow pull-out.
  - Interior shots are kept to room scale: the camera stays at or below 3 m.

## Blending and overrides

- A user-picked entry outranks an auto match.
- The recipe comes from the best-fitting pick. Ranking: technique, then genre, then coverage, then emotion, then movement. Beat words must overlap the scene, and the recipe's cast size must fit.
- Picked genres and movements act as a style layer over that recipe:
  - **Lens band:** e.g. French New Wave keeps lenses at 25–50mm.
  - **Handheld:** a static template becomes handheld when the style is ≥ 30% handheld.
  - **Look fragments and aspect ratio:** the genre owns the frame shape.
- Each adjustment is stated in that shot's rationale ("Adjusted: lens pulled from 100mm to 50mm…").

## Tests

```bash
python3 -m pytest tests/test_cine*.py
```

There are 65 Python tests. Locally they use a stub `comfy_api`; on the pod, the real one is imported if available.

## Not done yet / next

- Retrieval is keyword-based. Embeddings would catch paraphrases.
- The stage has no camera roll, so Dutch angles are reported as `dutch_deg` but not shown.
- The ShotVL "script supervisor" verification loop (research/08 §7.8) is not built.
