# Coach: advice as you work

The Coach watches the stage, the cut and the App, and shows at most two small cards in the stage's top-right corner. Each card says what looks wrong, why, and offers a one-click fix. It never blocks anything: Run always runs.

Card controls:
- **Not now** hides that one situation until the scene changes.
- **Don't show again** turns that rule off for good. It is stored in `localStorage`, behind try/catch.
- The **Coach** pill turns the whole thing on or off.

## Mounting (integrator)

```js
import { Coach } from "./coach/coach.mjs";
const coach = new Coach(view, {               // the stage view element; cards float in its corner
  stage, app, api,
  getCut: () => ({ ...buildCutProject(), ...loadCut() }),   // {cut: [{shot_id, in, out}], …}; optional
  onAction: (kind, payload) => { … return true; },          // see below
});
// on tab switches:
coach.notify("tab", name);
```

The Coach picks up the following by itself:
- **Stage edits:** shot add/switch, a 1.2 s poll of `stage.toJSON()`, debounced.
- **Run:** it wraps `app.queuePrompt` once for all Coach instances, checks, then always queues.
- **Final renders:** it listens for the api `executed` event of a node titled `Rung 4…`.
- **First open:** it shows the 4-step tour (orbit/dolly, add things, keys, Run the ladder).

### `onAction(kind, payload)`

Return `true` when you handle an action.

| kind | payload | expected |
|---|---|---|
| `reorder_cut` | `{order: [shotIds]}` | reorder the strip/cut |
| `trim_shot` | `{shot_id, out}` | set that cut entry's out frame |
| `open_tab` | `{tab: "look" \| "advisor"}` | switch tab |
| `describe` | `{}` | focus the Describe box |
| `set_step` | `{step: 1}` | fallback: sets the `SoundstageStep` widget |
| `set_freedom` | `{value: 0}` | fallback: sets `SoundstageQuality.motion_freedom` |

Scene fixes (`ops`) don't go through `onAction`. The Coach applies them itself with `applyOps` from `web/agent/agent.mjs` (`stage.load` + `stage.onChange`), so they land in the stage's own Undo/Redo.

## Rules (`web/coach/rules.mjs`, pure, node-testable)

| Rule | Fires when | Fix |
|---|---|---|
| `story_order` | Advisor shot numbers (`shot.advisor.shot`) out of order in the cut, or a close-up opens the cut while a wide comes later (2+ people) | Reorder / Move the wide first |
| `camera_clip` | any camera key, sampled every 8 frames, is below the floor, outside the room/tank/street walls, or inside an object | Move it out: back along the view line (or toward the target), lens rescaled to keep the framing |
| `leaves_frame` | a person visible at the cut's in-frame is out of frame for the last ≥ 20% (min 12 frames) of what the cut shows | Trim the shot |
| `tiny_subject` | a single/OTS/insert/POV where nobody fills ≥ 3% of the frame | Push in (lens ×1.8) |
| `line_crossing` | consecutive cut shots on opposite sides of the A–B line (moving cameras and on-axis neutrals are exempt) | Mirror the camera across the line |
| `too_fast` | a segment faster than the kind's top speed: person 9 m/s, child 7, horse 20, dog 15, cat 13, bike 20, car 70… (mounted riders judged via their mount) | Slow down: retime the keys (or shorten the path if there's no room) to 90% of the limit |
| `stale_render` | step > 1 and the scene changed since the last Rung 4 render | Go to step 1 |
| `step_high` | step > 1 after edits with no final render seen | Go to step 1 |
| `motion_freedom` | `SoundstageQuality.motion_freedom` ≥ 0.8 (a very soft guide can drift framing) | Set to 0.5 |
| `no_look` | a Look node is present with nothing picked, and the stage isn't empty | Open Look |
| `empty_scene` | no actors | Describe the scene / Open Advisor |
| `tour` | first run, 4 steps | Next / Skip tips |

Which rules run on which event:

| Event | Rules |
|---|---|
| stage edit | camera clip, too fast, motion freedom, stale render, empty, tour |
| shots changed | camera clip, framing, 180°, story order, tour |
| tab | Look, empty |
| open | tour, empty, motion freedom |
| Run | story order, 180°, camera clip, framing, too fast, motion freedom, stale render, Look |

Cards are ranked error > warning > tour > tip, and at most two show at once.

Geometry mirrors the stage:
- Catmull-Rom key interpolation (a parity test runs against `Stage._sample`).
- The 36 mm sensor with the frame aspect from `stage.fw/fh`.
- Set camera areas and object footprints from `soundstage/agent/catalog.py`.

## Files and tests

- `web/coach/coach.mjs`: `Coach` (UI, hooks) and `CoachEngine` (mute/snooze/storage, no DOM).
- `web/coach/rules.mjs`: the rules.
- `web/coach/demo.html`: standalone demo with the real Stage, a troubled scene and a stand-in app.
- `tests/js/coach.test.mjs`: 16 tests.
  - Every rule fires on a broken scene and stays quiet on a clean one.
  - Every scene fix clears its problem and undoes exactly.
  - The engine's snooze/mute/enable persist, and it survives throwing storage.
  - The tour order is fixed.
  - Interpolation matches the stage.

```bash
node --test tests/js/coach.test.mjs
```

```bash
cd web && python3 -m http.server 8765
```

With the server running, open `http://127.0.0.1:8765/coach/demo.html`.

## Limitations

- "Story order" knows the story only from Advisor shot numbers or the wide-first convention. Hand-made shots without tags are judged only by that convention.
- The leaves-frame check projects the feet-to-head line, not the full silhouette. Someone half out of frame still counts as in.
- `stale_render` only knows about final renders that happened while this page was open.
- The poll compares the whole scene JSON every 1.2 s. That is cheap, but it means fixes can show up to ~2 s after an edit.
