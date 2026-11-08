# ✦ One-click

Everything a one-click AI video app does, built into Soundstage, with a real 3D film set behind it.

A **✦ One-click** button sits on every take and every frame:

- each Dailies take card and each row of its takes list;
- the Ladder bar (the final, draft or frame on view);
- every ④ Frame candidate.

The button opens one window over the canvas, in the Presets window's style. Every card is visible. A card that doesn't apply to this take stays in the grid, greyed, with the reason ("works on clips", "needs a frame painted from the stage", "it's already 16:9").

Clicking a card asks once: how many jobs it puts on your GPU and about how long. Local open models cost no credits. Then it runs.

The result lands as a **new take** on the shot: Takes, approvals, compare, **Use as ④ Frame** for stills, and **✦ again** to chain another one-click. The take checks and the realism judge (the VFX-supervisor pass) then run on it, and their chips show on the result.

## The cards

| Group | Card | Still | Clip |
|---|---|---|---|
| Effects | Nightfall, Flood, Rain, Snow, Fog, Golden hour | One FLUX 3 Klein edit with our physical prompt | The same edit on frame 1, then **LTX Ripple** carries it through the clip with its motion, camera and sound (2 jobs) |
| Effects | Empty the scene | Klein: people and vehicles out, the place continues behind them (or name what to take out) | LTX-2.5 **clean-plate** IC-LoRA (the plate has no sound) |
| Effects | Cutout | BiRefNet on the main subject, or SAM 3.1 when you name it ("the dog"); RGBA PNG | LTX-2.5 **alpha-gen** IC-LoRA: **ProRes 4444 with alpha** to deliver, plus an MP4 preview on black as the take |
| Effects | Living photo | LTX-2.5 image to video: 5 s of small real motion and ambient sound, camera locked off | n/a |
| Effects | Pop, Inflate, Cake, Squish, Unzip, Gulp (**experimental**) | LTX-2.5 image to video with a *practical-FX* reading: a balloon replica, an inflatable double, a cake replica cut with a knife, a foam replica, a costume zip, a creature puppet | n/a |
| Light | The App's 18 lighting setups (three-point, Rembrandt, butterfly, loop, split, clamshell, high-key, noir, silhouette, window, book light, practical night, moonlight, neon, firelight, horror underlight, interrogation, golden backlit) | Klein relight written from the setup itself: each light's role, side, height, hardness, colour temperature and the key-to-fill ratio. On a ④ Frame candidate of the open shot, an **experimental**, off-by-default box adds a Krea 2 pass locked to the stage's exact depth (Krea2 depth-control LoRA, denoise 0.45) | Relit frame 1, then Ripple with colour matching off |
| Camera | Orbit left / right, Low angle, High angle, Push in, Pull back · **approximate** | Klein re-imagines the moment from the new camera. Whatever the move reveals is invented, and the card says so | Reshoot (Track B) |
| Camera | The same six · **exact** (**experimental**) | On a ④ Frame candidate of the open shot: the shot camera moves on the 3D stage (`stage.previewCamera`, nothing on the shot changes), the stage renders its Color and Depth passes from there, and Klein paints the new frame locked to that geometry (the ④ Frame lock recipe, stage_denoise 0.9). The look comes from the shot's description, not from the original frame: given the original as a reference, Klein copied its camera and ignored the move | n/a |
| Frame | Expand to 2.39:1, 1.85:1, 16:9, 4:3, 1:1, 9:16 | Paint Studio's Extend: `SoundstagePadForFill` grows the canvas (never crops), `SoundstageFill` paints only the new area with a feathered, colour-matched seam | **Not yet:** the LTX-2.3 in/out-painting IC-LoRA needs one test on LTX-2.5 first |

Track B adds Loop, Reshoot, Open in ComfyUI and the phone hand-off to the same window.

Every prompt is ours, written for this App. Each effect prompt asks for the same people, objects, camera position, lens and framing ("a change of the world, not a new picture"), and describes the physics of the effect: the water line and the wet band above it, practicals on at night, reflections in rain, snow on ledges and fog falloff over 30-50 m.

## How it runs

The cards build ordinary ComfyUI API prompts from nodes this pack already has:

- `SoundstageImageLoad`;
- `SoundstageEditImage`;
- `SoundstageFill` and `SoundstagePadForFill`;
- `SoundstageMatte`;
- `SoundstageCleanPlate`;
- `SoundstageGenerateVideo`;
- `SoundstageRipple`;
- `CreateVideo` and `SaveVideo`;
- VHS for ProRes.

The browser queues these prompts under its own client id, like Ripple does. The model keys come from `/object_info`, so a card names the model it would use or says what's missing.

Results save to `output/soundstage_private/oneclick/<shot>_<card>…`, which is private and never the shared references.

## For developers: the registry

`web/oneclick/oneclick.mjs` is the contract every one-click module registers into:

```js
registerOneClick({
  id, group,            // "Effects" | "Light" | "Camera" | "Frame" | "Loop" | "Hand-off"
  label, hint,          // card text, plain words
  applies,              // ["still"] | ["clip"] | ["still","clip"]
  gpu, minutes,         // false for Open in ComfyUI; shown as "$0 · about N min on your GPU"
  available(target),    // -> true | "why not"
  run(target, ctx),     // -> Promise<{file, kind} | {take}>; ctx.queue(), ctx.wait(), ctx.upload(), ctx.addTake(), ctx.toast()
});
```

Optional fields:

- `jobsFor(target)` and `minutesFor(target)` give the cost per kind;
- `fields` are the options shown in the ask strip (text, a checkbox, a select);
- `badge` is approximate, exact or experimental;
- `preview` and `overlay` sketch the effect on your own picture, as a CSS filter and a gradient;
- `keywords` feed the search.

`MODULES` in the same file lists the modules the App loads.

## MCP

`soundstage_one_click` in `tools/soundstage_mcp.py`:

- **No `id`:** it lists what applies to a shot's take. By default that's the open shot and its circled take, else the latest final > draft > frame.
- **An `id` without `confirm_gpu`:** it proposes the run and says what it will cost.
- **`confirm_gpu: true`:** the open App runs it, and the take lands with the realism judge's verdict. Ask the user before you send this.

The server only relays the call (`soundstage/oneclick/routes.py`, `POST /soundstage/oneclick/ask`). The App does the work, so the result is a take like any click.

## Honest limits

- **Klein edits can drift.** A face, a sign or a small object can change in an instruction edit. That is why every result goes through the take checks and the realism judge.
- **The Krea 2 depth-locked relight invents.** In the 2026-11-02 test (Neon on the night chase), the Klein relight alone kept every object and lit the street magenta and cyan with wet reflections. The Krea 2 pass on the stage depth, at denoise 0.45, painted a different street with three invented people. The box is off by default and labelled experimental.
- **Exact angles get the geometry right and the look wrong.** On the night chase (2026-11-02 test), "Orbit left · exact" framed the car exactly as the moved stage camera saw it. But the car kept its grey stage surface, and the street became a plain blue wall, because only the shot's words describe the look. The cards are marked experimental until Track C's depth-locked frame (Krea 2 on the stage depth) can paint them.
- **Approximate angles are invented.** A new angle from one picture invents whatever the move reveals. Use the exact cards on a ④ Frame candidate when the geometry matters.
- **Clip effects carry frame 1.** Something that only appears later in the clip may not take the effect. A big event can wash it out: on the chase clip, Ripple carried a flood up to the crash, then the water was gone after it (2026-11-02 test).
- **Effect prompts say "add nothing".** The first knee-deep Flood on the chase clip invented a man standing in the street, and Ripple kept him for the whole clip. Every effect prompt now says to add no new people, animals, vehicles or objects. The take checks and the realism judge are still the guard.
- **The judge is lenient on stills.** It passed the thin-film Flood still at 10/10, with one minor face note.
- **The judge can time out on a busy GPU.** The realism judge runs as a queued GPU job. When other jobs fill the queue, the browser's request can time out, and the result shows "not judged". Judge it again from the take's chips once the queue is free.
- **Practical-FX cards are experimental.** They use prompts only, with no effect LoRAs, and cartoon physics conflicts with the Hollywood-real bar. Judge them hard.
- **Clip Expand is off** until the LTX-2.3 in/out-painting IC-LoRA is tested on LTX-2.5.
