# Look tab

The Look tab holds the Cinema-Studio-style look controls. They compile the two prompts the ladder needs: the **look still** prompt for rung 2 and the **LTX motion** prompt for rungs 3–4. Following docs/decisions.md (2026-10-28), the Stage owns the physical shot: blocking, focal length, camera height, time of day, weather and set. The Look owns how the shot is photographed. Changing only the look leaves SoundstageStage's value untouched, so the ladder re-runs from rung 2.

## Files

| Path | What it is |
|---|---|
| `web/look/vocab.mjs` | The vocabulary, shared by the panel and the node. The body after `export const VOCAB =` must stay strict JSON, because Python parses this file. |
| `web/look/look.mjs` | `LookPanel`, a self-contained UI module. It imports only `./vocab.mjs` and injects its own CSS. |
| `soundstage/look/vocab.py` | Loads the vocab. Also holds `DEFAULT_LOOK`, `normalize_look()`, and `look_from_text()` for typed looks. |
| `soundstage/look/scene.py` | Reads the stage scene. Frame-1 facts: who is where, shot size, angle, props, place, lighting. Motion facts: the camera move split into documented verbs, each actor's marks, and the final frame. |
| `soundstage/look/compile.py` | `compile_look(look, scene)`. Returns the still prompt, still negative, motion prompt, KB refs and notes. |
| `soundstage/look/colors.py` | Turns hex swatches into colour words using the nearest named colour in CIELAB. |
| `soundstage/look/routes.py` | `POST /soundstage/look/compile` and `POST /soundstage/look/parse`. These serve the panel's live preview and its "type a look" box. |
| `soundstage/look/default_scene.py` | A Python copy of the stage's `DEFAULT_SCENE` (the walk-in shot). A test checks it against the JS. |
| `soundstage/look/example.py` | `python3 -m soundstage.look.example "<typed look>"` prints the prompts. |
| `soundstage/nodes_look.py` | `NODES = [SoundstageLook]`. |
| `tests/test_look.py`, `tests/test_look_scene.py` | 37 tests. |

## Vocabulary (Cinema Studio 4.0 vs Look tab)

| Control | Higgsfield CS 4.0 | Look tab |
|---|---|---|
| Camera body | 4 + Auto (Modern, 35mm Film, 8mm Film, DV Camcorder) | **25** + Auto. Covers the four CS 4.0 bodies and the CS 3.5 ones, plus Alexa 35/65/Mini LF, RED V-Raptor, Venice 2, DXL2, URSA, IMAX 15/70, 65mm, Super 16, Bolex, silent hand-crank, Technicolor 3-strip, early HD, VHS/Hi8, broadcast, smartphone, GoPro, drone, CCTV and bodycam |
| Lens character | 5 + Auto | **19** + Auto. Covers all five CS 4.0 lenses plus Panavision C, Cooke S4, Super Speed, K35, 70s zoom, Petzval, Helios, Pro-Mist, tilt-shift, macro, fisheye, split diopter, probe and long tele |
| Aperture | 3 | **8** (f/1.4 to f/16) |
| Film stock / sensor | — (an Era side effect) | **21**: Vision3 500T/250D/50D/200T, Eterna, Ektachrome, Kodachrome, CineStill, Technicolor IB, faded Eastmancolor, bleach bypass, cross-process, push, Double-X, Tri-X, HP5, Aerochrome, clean Rec.709, ARRI look, HDR, VHS |
| Colour palette | 50+ presets, custom hex, from image, randomize | **31** presets with 5 swatches each, plus custom swatches (colour picker and hex, up to 12), **From image…** (k-means, 5 swatches), Randomize and a name field. Swatches compile to colour words ("deep teal, teal, sea green…") |
| Genre | 7 | **17** + General, each with **subgenres (73)** |
| National cinema / movement | — | **21**: all 8 KB entries plus 13 more |
| Era | Auto, 60s, 80s, 90s, 2000s, 2020s | **12**, adding the 1920s–50s, 70s, 2010s and near future |
| Director technique | (CS 3.5 MoveSet styles, removed in 4.0) | **18**: all 12 KB techniques plus 6 named by technique, including the CS 3.5 styles (Silent Machine = Motivated Locked Camera) |
| Mood / emotion | 8-emotion wheel + intensity | The 8 wheel emotions + 15 more (10 from the KB recipes), with an intensity slider |
| Energy | Tempo (5) | 4 + Auto (motion prompt only) |
| Grade | Post colour grading | Contrast, saturation, warmth, grain, halation and vignette sliders |
| Describe the scene | Prompt box | Text box. The still prompt keeps only clauses that can be true in frame 1: "…, then they walk inside" is dropped from the still and kept in the motion prompt |

Options marked ◆ in the UI come from `soundstage/cine_kb`. Their KB names and one-line summaries appear under the preview as "why this look".

## Look JSON (v1)

```json
{
  "version": 1,
  "camera_body": "auto", "lens": "anamorphic", "aperture": "auto", "film_stock": "auto",
  "palette": {"preset": "teal_orange", "name": "Teal & orange",
              "swatches": ["#0f3d47", "#1f6f78", "#7fb8b0", "#e0904a", "#f2b880"]},
  "genre": "thriller", "subgenre": "thriller.revenge",
  "movement": "korean_thriller", "era": "auto", "technique": "auto",
  "mood": "dread", "mood_intensity": 0.5, "energy": "auto",
  "grade": {"contrast": 0.0, "saturation": 0.0, "warmth": 0.0, "grain": 0.0, "halation": 0.0, "vignette": 0.0},
  "description": "a detective in a wet trench coat and a nervous witness",
  "negative": "",
  "brief": {"world": "a rain-soaked Seoul back street in 1998", "atmosphere": "humid haze", "surfaces": "wet asphalt, tiled walls",
            "furniture": "plastic chairs stacked by a shutter", "colour": "cold green fluorescents against warm skin",
            "light": "one sodium lamp", "outside": "a neon-lit alley"}
}
```

- Every id is an `id` from `vocab.mjs`. `"auto"` (and `"general"` for genre) means no logic.
- **`palette.preset`:** a preset id, `"custom"` or `"auto"`. Editing a preset's swatches makes it `"custom"`.
- **`subgenre`:** the full id (`"noir.neo"`). Its genre is inferred if missing.
- **`mood_intensity`:** 0–1. Below 0.3 the prompt reads "a faint undertone of …"; above 0.8, "… played at full intensity".
- **`grade`:** values are −1..1 (0..1 for grain, halation and vignette). |v| < 0.2 is ignored and |v| < 0.5 reads "slightly …".
- **Missing or unknown fields** are filled or dropped by `normalize_look()`, and each one dropped is reported in `notes`.

**Conflicts are resolved and noted:**
- Any black-and-white choice (B&W stock, classic noir, silent camera, Soviet montage…) drops the colour palette and adds "colour" to the negative.
- A shallow aperture on a phone, CCTV or DV body: the aperture wins in the prompt.

## Restyle brief and the lock clause

`brief` is optional. It follows the final-render brief in Higgsfield's 3D Jutsu: one free-text line each for `world`, `atmosphere`, `surfaces`, `furniture`, `colour`, `light` and `outside` (the view outside the windows). In the Look tab it's the collapsible **Restyle brief** card under Grade. The card header shows how many lines are filled in.

- **Normalising:** whitespace is collapsed and each line is capped at 400 characters; unknown keys are dropped.
- **Still prompt:** each line goes in after the description, with a short label ("surfaces: …", "outside the windows: …"). Each line is trimmed to its frame-1-safe clauses, so "sodium lamps, then the power cuts" becomes "sodium lamps".
- **Motion prompt:** all the lines go in as one sentence after the description.
- **Lock clause:** the motion prompt **always ends with** `LOCK_CLAUSE` = "The layout, object placement, scale and camera motion match the reference exactly."
  - It's written in LTX's style: present tense and stated positively, with no "don't" and no "keep".
  - It is never added to the still prompt.

## Node: Soundstage · Look (`SoundstageLook`, output node, category "Soundstage")

**Inputs:**
- **`look`:** a socketless multiline STRING. It takes either the look JSON (filled by the Look tab) or a typed look such as `Korean thriller, anamorphic, teal-orange, a detective and a witness`. Words that match the vocabulary set controls; the rest becomes the description.
- **`scene_json`:** optional, wired from **SoundstageStage.scene_json**. The raw stage widget value `{scene, passes}` is also accepted. If it is empty or unreadable, the default walk-in scene is used.

**Outputs:**
- **`still_prompt`:** frame 1 only.
  - The style head comes first (movement, then subgenre/genre).
  - Then era, the frame-1-safe description, shot size, each group with its frame position and facing, and the exact head count ("exactly two people in frame").
  - Then angle, focal mm, lens, aperture, place, visible set pieces, weather, the stage lighting note, technique, mood, palette words, stock, body and grade.
  - It never mentions motion or end positions.
- **`still_negative`:** always contains "extra people, crowd, duplicate figures, the same person twice", plus the base artefact list and any look-specific negatives. With 0 people in frame it adds "people, person, figure".
- **`motion_prompt`:** one LTX paragraph, in this order:
  1. INT/EXT, shot size and place.
  2. Lighting with numbers removed.
  3. Blocking in frame terms.
  4. The set.
  5. The description.
  6. Actor marks: walk / walk briskly / run, toward / away / across, "into the building through the doorway".
  7. The camera move in documented verbs, with its destination frame: "as the move completes, …".
  8. Lens band (wide-angle / normal / portrait / long, no mm), then lens and aperture character.
  9. Body, stock, palette, grade and era.
  10. Cinema style, technique, mood, energy.
  11. Ambience from the KB signature. Rain sounds are dropped unless the stage has rain, and voiceover lines are always dropped.
- **`look_json`:** `{look (normalised), still_prompt, still_negative, motion_prompt, kb_refs, kb[{id,name,summary}], notes, frame1{people,size,angle,focal_mm}, palette_words}`.

**How the scene is read:**
- **Formats:**
  - Current: `camera_keys`, per-actor `keys` and `camera_track`. `camera_track` takes precedence when present.
  - Old: `camera`/`camera_end` and `position`/`position_end`.
- **Actor classes:** taken from `web/stage/library.mjs` rigs.
  - Biped: counts as a person.
  - Quadruped and vehicle: named but not counted.
  - Static library objects (tree, bench…): set dressing.
- **Hidden figures:** actors inside a building at the last frame are treated as hidden. That is how the default shot ends on "…have disappeared through the doorway".
- **Moves:** the camera move is split into push/pull, truck L/R, crane up/down, pan L/R, tilt, zoom and arc, all relative to the start camera.
  - If the movers walk away from a pushing camera, it reads "The camera follows behind them, drifting right and panning right".
  - A jittery `camera_track` adds "handheld".

## Routes

- **`POST /soundstage/look/compile`:** `{look, scene}` → the `look_json` dict above. This is the same function the node runs.
- **`POST /soundstage/look/parse`:** `{text}` → `{look, matched}`.

`nodes_look.py` registers both routes when it is imported inside ComfyUI. They live under `/soundstage/`, the same namespace as `routes.py`.

## Integrator: mounting LookPanel in a "Look" tab

`LookPanel(container, getScene, {fetchApi, debounceMs})`. Members: `toJSON()`, `load(json|string)`, `refresh()`, `dispose()`, and an `onChange(look)` callback.

1. **Register the node.** In `soundstage/nodes_stage.py`, add `"nodes_look"` to the module list in `SoundstageExtension.get_node_list()`.
2. **Add the tab** in `web/soundstage.js`, next to Stage and Ladder:
   ```js
   import { LookPanel } from "./look/look.mjs";
   // …in createStageWidget, after the stage exists:
   const lookView = document.createElement("div");
   lookView.className = "ss-lookview"; lookView.hidden = true;   // shown by the "Look" tab button
   root.appendChild(lookView);
   const look = new LookPanel(lookView,
     () => ({ ...stage.toJSON(), lighting_prompt: stage.lightingPrompt() }),   // the same lighting note the run uses
     { fetchApi: (path, init) => api.fetchApi(path, init) });                  // respects ComfyUI's base path
   ```
   - The panel refreshes itself whenever it becomes visible, because a ResizeObserver sees width go from 0 to >0.
   - To keep the preview live while both are on screen, also call `look.refresh()` from the stage's `onChange`.
3. **Persist into the node.** The look must live on SoundstageLook's `look` widget, not in the stage value. Putting it in the stage value would change the stage hash and re-run rung 1 on every look tweak.
   ```js
   const lookNode = () => app.graph.findNodesByType?.("SoundstageLook")?.[0]
     ?? app.graph._nodes.find((n) => n.comfyClass === "SoundstageLook");
   const lookWidget = () => lookNode()?.widgets?.find((w) => w.name === "look");
   look.load(lookWidget()?.value || "");                       // on widget creation / workflow load
   look.onChange = (j) => { const w = lookWidget(); if (w) { w.value = JSON.stringify(j); app.graph.setDirtyCanvas(true); } };
   ```
   With no SoundstageLook in the graph the panel still works as a prompt designer: Copy buttons, live preview.
4. **Wire the workflow** (Shot v2 ladder / Soundstage App):
   - `SoundstageStage.scene_json` → `SoundstageLook.scene_json`
   - `still_prompt` → the Krea 2 look-still positive text
   - `still_negative` → its negative
   - `motion_prompt` → the LTX text encode

   These replace the App's three hand-typed inputs (look-still prompt, negative, motion prompt). A user who still wants to override can put a text node in between.
5. **CSS:** `look.mjs` injects `#soundstage-look-css`, with every rule under `.ss-look`. It doesn't touch the stage CSS. At 340 px (the App-mode side panel) everything fits with no horizontal overflow; checked in a browser.

## Example: default walk-in scene + "Korean thriller, anamorphic, teal-orange"

`python3 -m soundstage.look.example` (scene = `DEFAULT_SCENE`: a man and a woman walk from the plaza through the building's doorway while the camera follows, 35 mm, sun at 18°):

```text
LOOK  Korean thriller, anamorphic, teal-orange
      typed look: korean thriller -> movement:korean_thriller
      typed look: teal orange -> palette:teal_orange
      typed look: anamorphic -> lens:anamorphic

STILL_PROMPT
Korean thriller film still, cold blue-green shadows against sodium-orange light, gritty realistic texture, wide
shot, a woman and a man side by side left of frame, with their backs to the camera, exactly two people in frame,
eye-level camera, 35mm lens, anamorphic lens, oval bokeh, horizontal blue streak lens flares, gentle edge
distortion, widescreen cinematic feel, in a city plaza, a building facade with a doorway right of frame; a pair of
planters framing the space, golden hour, sun 18° above the horizon behind the camera (front light), teal and
orange colour grade, teal shadows, warm orange skin tones

STILL_NEGATIVE
extra people, crowd, duplicate figures, the same person twice, motion blur trails, multiple exposures, split
screen, collage, text, watermark, logo, frame border, letterbox bars, deformed hands, extra fingers

MOTION_PROMPT
Exterior wide shot in a city plaza. Golden hour, low sun behind the camera (front light). A woman and a man start
side by side left of frame, with their backs to the camera. A building facade with a doorway stands right of
frame. They walk briskly together away from the camera into the building through the doorway. The camera follows
behind them quickly, drifting right and panning right; as the move completes, the woman and the man have
disappeared through the doorway ahead. Shot on a wide-normal lens, anamorphic optics with oval bokeh and
horizontal streak flares. A teal-and-orange grade, cool teal shadows against warm orange skin. The gritty realism
of a Korean thriller, cold blue-green shadows against sodium-orange light, the frame refusing to look away.
Sudden silence; melancholy strings or ironic upbeat music.

KB refs: movement.korean_thriller   notes: -
```

## Real people, not plastic figures (Milestone 5)

FLUX 3 Klein edits the stage's frame 1, so it copies what it is handed. The clay figures have blank faces (no eyes, no mouth) and helmet hair, and in a wide shot a head is only 25-35 px of a 960 x 512 frame. Klein kept those figures and only re-textured them: doll-like riders. Two changes fix it without touching the blocking:

- **The start image** (`soundstage/look/look_start.py`, applied to the stage node's `first_color`):
  - **Clay heads softened.** Each person's head is found in the ID pass (top of the silhouette down to the shoulders) and blurred, feathered at the edge. Pose, placement, build, wardrobe and hair colour stay, and the model casts a real face there.
  - **Upscaled when faces are small.** If the largest head in frame is under 64 px, frame 1 is upscaled (at most 1.75x, so 960 x 512 becomes 1680 x 896, about 1.5 MP) and the still is made at that size. Close shots stay at stage size. Making the windshield shot at 1 MP pulled the camera back and shrank the people, so close shots are not upscaled.
  - Only library people (man, woman, child) are touched. Horses, cars, props and custom objects pass through unchanged. With no ID pass, or no people in frame, nothing changes.
  - Frames picked before this change still reproduce exactly. The App records `ls` with each new frame. For an older pick it sends `look_start: false` in the stage value, and the node then passes the plain colour pass.
- **The still prompt** (`compile.py`): when people are in frame it adds `REAL_PEOPLE` ("real actors, natural skin texture, real hair and fabric with creases, candid unposed body language, natural expressions") after the head count. It also adds `REAL_PEOPLE_NEG` (plastic skin, mannequin, doll-like faces, CGI character, 3D render) to the negative. A look whose description or brief asks for animation, claymation, anime, painting and the like gets neither. Kodak 200T now says "natural skin tones" (it used to say "smooth skin").
- **Tried and dropped:**
  - Blurring the whole person kept fewer wardrobe details and was no better than softening the head alone.
  - Softening the whole frame made the still look less real.
  - An edit-instruction lead-in ("Turn this rough 3D previz render into a real photograph...", or a neutral "Make this a real photograph...") looked the same as the plain realism words over 3 seeds.
  - A larger output with a stage-size reference made the faces best of all, but the riders moved and turned on some seeds.
  - The Follow-the-clay slider only drives Krea 2's img2img denoise (node 9056). Klein starts from noise (ReferenceMultiLatent, denoise 1), so the slider does nothing for Klein.

Evidence and side-by-sides: share/Milestone5_Realism.

## Known limits

- The typed-look parser is phrase matching. Generic words were removed from the aliases ("red" doesn't pick the RED camera), but a description that says "detective" with no genre set will pick the detective subgenre.
- The anamorphic look is described in words only. The frame stays 960×512, and "letterbox bars" is in the negative.
- Actor paths are sampled linearly between keys, while the stage uses Catmull-Rom. The ends are exact, so the words are the same.
- **Bug spotted in `web/stage/lighting.mjs`** (not changed here): `describeLighting` computes `right = (view.z, 0, -view.x)`, which is screen-LEFT in the stage frame (+X is screen-left looking down +Z). As a result its "from camera right/left" side-light words are mirrored. The Python fallback in `look/scene.py` uses the correct basis. It only runs when the scene has no `lighting_prompt`.
