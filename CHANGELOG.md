# Soundstage changelog

Soundstage is updated continuously on `main`. Newest first. Times are US Pacific.
Each entry links to the code; every milestone ships with tests.

## 2026-10-31

**16:22 PDT · A selected person can be grabbed by the body again (they mount the horse)** *(QA round 03)*
- Fixed: after a climb onto a crate and Undo / Redo / Undo (or any time a person was already selected), dragging them onto a horse slid them about 1 m along one line and nothing happened. Undo left them selected, so the move arrows showed at their feet, and from a raised view the arrow pointing away from you is drawn right up across their body; a press there went to that arrow. Now a press on a selected person's body always grabs the person (the live drag: walk, climb, mount); the arrows still work where they stick out past them. On other objects only an arrowhead keeps the press, and Shift+drag still locks a drag to one axis.
- Code: [web/stage/stage.mjs](web/stage/stage.mjs) (`_gizmoTakesPress`). Tests: [tests/js/qa_round03.test.mjs](tests/js/qa_round03.test.mjs).

**15:49 PDT · The pro look: calmer colour, one main button a step, a shortcut sheet** *(Milestone 14)*
- **One design system.** `web/ui/theme.mjs` now holds the tokens: one type scale (11 · 12 · 13 · 15 · 18 px, nothing smaller), a 4 px spacing grid, radii, and hover, pressed, focus and disabled states shared by every button and field. Secondary and hint text are brighter: every text colour passes WCAG AA (4.5:1) on the background, the cards and the glass panels.
- **Yellow means "do this".** A picked option (variations, quality, Follow, Review's compare chips, Cast sizes) is now a raised grey segment, not another yellow button. Each step keeps one yellow action: Build this scene, Generate all missing, Generate frames, Render final + sound, Cut → one video. "Animate this frame →" and "Review →" are quiet outlined buttons. The status line is grey, not yellow.
- **Keyboard shortcuts.** Press **?** anywhere in the App (or the keyboard button in the top row) for a sheet of every key and mouse move, Milestone 9's 3D drags included: drag, Shift axis lock, Alt turn, wheel lift, C pick up, Cmd drag without snapping, F frame, G / R / T, P pose, 0 free view, W A S D fly, H / Tab hide panels, Cmd+Z undo. Tooltips show the key (Undo ⌘Z). The viewport's long help line, which was always cut off, gave way to it.
- **First five seconds.** The "Let's make a shot" card fades in over a dimmed stage, with one yellow way in and two quiet ones, a "New stage" label and a "Shortcuts ?" hint. While it shows, the header's Import video is a quiet copy and the small drop-a-video pill steps aside.
- **Panels.** Fold buttons are chevrons, not "+" and "–"; section heads have one chevron style. ③ Set › Object puts Add and the Outliner first and folds Import 3D, Import world, Import image and Export GLB under **More: import & export** (Photo → 3D opens it). A selected object's tools are one row of icon buttons with tooltips (Move, Rotate, Scale, Measure, Snap, Physics, Duplicate, Delete).
- **⑦ Deliver.** Three tidy cards in plain words; the cut as one video comes first and is the step's one yellow button.
- **QA round 02's design notes.** ② Cast has a new default size, **Fit**: every card fits on one screen, without scrolling, with each card's buttons on its picture and the description one click away. ④ Frame's Style and Camera pickers open as full-height pop-overs with a search box instead of scrolling in small boxes. ⑤ Motion and ⑦ Deliver show the start frame (or the clay) instead of an empty black player at 0:00. ⑤ Motion no longer says "Video model" twice. ③ Set's inspector no longer scrolls once an object is selected.
- Evidence: before and after screenshots of every step, and the first ten seconds of opening the App, in `share/Milestone14_ProLook/`.
- Code: [web/ui/theme.mjs](web/ui/theme.mjs), [web/ui/shortcuts.mjs](web/ui/shortcuts.mjs), [web/ui/canvasui.mjs](web/ui/canvasui.mjs), [web/ui/firstrun.mjs](web/ui/firstrun.mjs), [web/cast/cast.mjs](web/cast/cast.mjs), [web/pipeline/pipeline.mjs](web/pipeline/pipeline.mjs). Tests: [tests/js/prolook.test.mjs](tests/js/prolook.test.mjs).

**15:41 PDT · Stunts, round 2: a meaner reverse J-turn that stays the same car** *(Milestone 13)*
- **Reverse J-turn preset, retimed.** It now reverses at ~13 m/s and whips the 180° round in about 0.7 s (it was ~0.9 s). The body goes hard over (~10° of roll, keyed on top of the springs as `roll_deg`), the nose dips as it scrubs off speed, and the rear squats on the launch (`pitch_deg`). Re-apply the stunt to get the new keys.
- **A driver leans with the car.** Someone in a car seat now rolls and pitches with the body, so their legs no longer poke out under the floor in the clay.
- **② Cast: a car gets a turnaround.** Generate on a car, truck or bike now makes one vehicle sheet: front, rear, side and three-quarter views of the same car. ④ Frame paints the car from it, so a car seen tail-first in frame 1 has a front that belongs to it when it spins round.
- **② Cast: Generate uses what you just typed.** Typing a description and clicking Generate straight away used the old (often empty) description.
- **Cleaner prompts.**
  - A street of five lamps is one lighting phrase, not "warm tungsten practical" five times over.
  - A camera car braking and accelerating with a stunt car is no longer called "handheld".
  - A shot that ends on a car says so, instead of "the frame settles on the empty set" (which read as the car leaving).
- Evidence: share/Milestone13_Stunts/v2 (camera B, a bumper camera in the next lane: clay, reference sheet, Klein frame, drafts, final with sound, side by side).
- Code: [web/stage/stunts.mjs](web/stage/stunts.mjs), [web/stage/stage.mjs](web/stage/stage.mjs), [web/cast/cast.mjs](web/cast/cast.mjs), [web/stage/lighting.mjs](web/stage/lighting.mjs), [soundstage/look/scene.py](soundstage/look/scene.py), [soundstage/look/compile.py](soundstage/look/compile.py). Tests: [tests/js/stunts.test.mjs](tests/js/stunts.test.mjs), [tests/js/shotcast.test.mjs](tests/js/shotcast.test.mjs), [tests/test_stunts.py](tests/test_stunts.py).

**14:49 PDT · New sets: scene setup frames them, and the showcase renders** *(Milestone 11)*
- Setting up a scene onto a new set (INT. AIRPLANE CABIN, INT. TRAIN, EXT. TRAIN STATION, UNDERWATER, BURNING BUILDING) now also places that set's camera and blocking, not only on an empty stage.
- Showcase, made through the App (④ FLUX 3 Klein frame, ⑤ LTX draft): a diver over the reef, a firefighter past a burning building, a passenger at an airliner window, a passenger on a train with the countryside streaming by. Finals for the reef and the train.

**14:06 PDT · Movie car stunts: a reverse J-turn, a donut, a handbrake 180** *(Milestone 13)*
- Pick a car, then **Stunt ▸ Reverse J-turn / Donut / Handbrake 180** in its properties. The car's keys are written on the set you're on, from where it starts and the way it goes, and stay editable: drag the keys, or turn the car at a key with Turn.
- Keys can steer the nose now: `heading_deg` per key (unwrapped, so 0 → 720 is two spins) and `drive: "reverse"`. A stunt car turns as fast as its keys say; every other car keeps its real turning rate, exactly as before.
- The body sits on springs: it rolls out of turns, squats when the car launches and dives under braking, while the wheels stay planted. Wheels turn backwards in reverse.
- Tyre smoke pours off the wheels where the keys ask for it (`fx.tire_smoke`), or by itself when a stunt car slides or launches hard. It's the same puffs at every capture of a frame, so the clay, the guide and the video agree.
- The prompts tell the image and video models which end leads in each beat: rear end first, the spin, then nose first.
- Code: [web/stage/stunts.mjs](web/stage/stunts.mjs), [soundstage/look/stunts.py](soundstage/look/stunts.py). Tests: [tests/js/stunts.test.mjs](tests/js/stunts.test.mjs), [tests/test_stunts.py](tests/test_stunts.py).

**13:41 PDT · New sets, round 2: a real reef, scenery that moves, a softer view out of the train** *(Milestone 11)*
- The reef is dense along the swim lane: staghorn, brain, fan, table and tube corals where a diver swims past. People off the seabed swim in the prompt too ("swims", not "walks").
- Clouds past the airliner windows and countryside past the train windows now really stream by in the stage and the guides.
- On the train set, the view out of the window is softened in the LTX guide, so the video paints real fields and trees instead of clay shapes.
- A passenger in a cabin or carriage seat "sits by the window" in the prompts.

**13:38 PDT · Live 3D: off the horse, legs together** *(Milestone 9)*
- A rider dragged off a horse stands normally; before, their legs stayed spread as if still in the saddle.

**13:40 PDT · Cars face the way they drive: lit headlights and tail lights**
- In the Car Chase demo's chase-cam take the red sports car seemed to drive backwards. The clay was right. The look still (rendered on 10-29, before the prompt fix in 4c1b2e4) painted the car's front toward the camera, and the video then moved that front-facing car away down the street.
- The real-car bodies now light their lamps in the Color pass, which the video guide and the look still read: warm-white headlights, red tail lights. Clay and Depth are unchanged. See `Stage._upgradeVehicle` in [web/stage/stage.mjs](web/stage/stage.mjs).
- Two tests guard it. [tests/js/vehiclelamps.test.mjs](tests/js/vehiclelamps.test.mjs) checks the lamps glow and that on Car Chase frames each car's headlights lead its motion. `test_car_chase_vehicle_facing` in [tests/test_look_scene.py](tests/test_look_scene.py) checks every Car Chase shot's prompts say which end of the car faces the camera.

**13:36 PDT · QA round 02: a regression guard, and four layout fixes**
- With a render queued, the step names stay whole. Stop used to squeeze them to "Scri…", "C…", "S…" at 1440 px; the wordmark and the Guide / Done words now make the room.
- The App's narrow side panel shows one Import video button, not two. The small "Drop a video here" pill there no longer runs under the Coach pill.
- ⑤ Motion's settings panel fits at 1280×800: the duplicate "Follow" line under the FOLLOW heading is gone, so "Cast in this shot" is no longer cut off.
- The "Physics: CPU" badge no longer covers the status line ("Man 3 climbs onto Crate 1"). It only appears for the GPU solver, bottom right.
- New: `tools/qa/visual_baseline.mjs` captures 17 fixed screens at 1280×800, 1440×900 and 1920×1080 and compares them with committed baselines. It also checks pixels, console errors, page scroll, clipped text and overlapping panels. Every QA round runs it first. See [tools/qa/README.md](tools/qa/README.md).

**13:31 PDT · Live 3D: let go of a walking person and they stand** *(Milestone 9)*
- Releasing a person mid-stride no longer leaves them frozen with their legs apart until everything settles.
- The faint "where it started" ghost appears once the object has moved away, not as a flash on top of it at the press.

**13:20 PDT · Live 3D: stacks stand still; cars throw crates** *(Milestone 9)*
- A tall stack of boxes now stands perfectly still until something hits it (a 20-carton tower moves about 1 mm in 3 s; before, it sagged, twisted and fell).
- A crate a car drives into is thrown clear instead of being nudged along at walking pace. Dragged things keep their safety speed limit.
- A person dragged against a crate's corner no longer jitters; they climb as soon as they're at it.

**13:05 PDT · GPU physics (AVBD): solid car hits, standing stacks, a switch in the Physics panel** *(Milestone 10)*
- The GPU solver ([three-avbd](https://github.com/sbobyn/three-avbd)) now meets what it hits: contacts are made as far ahead as a body moves in a frame, so the Car Chase sports car at 12 m/s no longer drives 11 cm into a crate, crates no longer ride inside the bumper or get fired off at 35 m/s, and falling boxes land without sinking (worst overlap during a hit 114 mm → 6–31 mm; at rest under 0.5 mm).
- The "pile-up" (only 4–5 of 10 crates visible after the car hit) was not lost or merged crates: all 10 were there, 6 had been carried out of the camera by a test car that stopped dead at 43 km/h. The test now brakes like a car and frames the whole run-out.
- **Physics panel → Live solver: CPU / GPU · beta.** GPU runs live drags and pushes on the graphics card (WebGPU) and falls back to the CPU where WebGPU can't start; the badge on the stage says which is running. CPU stays the default for now.
- People can step through a crate's edge on the GPU too (ignorePair).
- Evidence: side-by-side videos and metrics in `share/Milestone10_AVBD/`.

**13:00 PDT · Live 3D: people walk where you drag them; faster live physics** *(Milestone 9)*
- A dragged person turns to face where they're going and their legs and arms swing in step (no more skating). A small nudge doesn't turn them.
- Riders' keys follow their horse; a person never shoots across the set when the cursor slips off a horse's back.
- Picking up (C) reaches a prop a little further away.
- The live physics is about 3x faster on crowded sets (a quick gap test before box contacts; fewer floor contacts).

**12:55 PDT · QA: the Guide finds its control in the App's narrow side panel**
- In ComfyUI's App mode the side panel scrolls. The Guide's first step now scrolls the "Let's make a shot" card into view instead of pointing below the fold.

**12:52 PDT · Live 3D: what you grab stays under the cursor, and lifting is straight up** *(Milestone 9)*
- The point you press on an object stays under the cursor for the whole drag, at any camera angle.
- The scroll wheel lifts a held prop straight up; carry it over a crate and let go to stack it.
- The move arrows hide while you drag, so you see the object itself.

**12:45 PDT · New sets: underwater, fire, airplane, train** *(Milestone 11)*
- ③ Set has seven new sets: **Underwater reef** (coral, kelp, light rays, bubbles; people swim), **Burning building** (night, flames, embers, smoke, flickering firelight), **Airplane cabin** (seat rows, bins, oval windows with clouds going by), **Airport runway**, **Above the clouds**, **Train carriage** (facing seats and tables, countryside streaming past) and **Train station platform**.
- New vehicles: an **airliner** and a **train** (locomotive and three carriages) that drive along on keys, nose first.
- **Fire** in Elements puts flames, embers and smoke on any set: a campfire in the forest, a burning car on the street.
- Script scene setup picks them from the slugline (INT. AIRPLANE CABIN, UNDERWATER, INT. TRAIN, EXT. TRAIN STATION, BURNING BUILDING) and seats the cast by the window.
- No text anywhere on the new sets, so nothing garbles in renders.

**12:37 PDT · Live 3D: drag it, and the set reacts** *(Milestone 9, in progress)*
- Physics stays live while you edit. Dragged objects bump, push, stack and settle, with no Simulate button needed.
- Drag a person onto a crate and they climb up. Over a horse, they mount it; drag them off and they dismount. Into a small prop, they pick it up, and putting it down drops it in front of them.
- Climbs and hops are eased with an IK step pose. Props have real-world weights: cardboard boxes are light, crates are heavy.

**11:55 PDT · Bring your world in, send it back out: Blender · Unreal · Maya · Nuke** *(Milestone 12)*
- ③ Set › **Import world…** turns a whole environment (GLB, glTF, FBX, OBJ) into the set. Units and up-axis are fixed automatically, with a size readout and a one-click scale fix.
- Floors and walls become physical. Cameras and animation in the file come in as shots and keys.
- ⑦ Deliver › **Download the DCC kit** gives you an animated GLB, camera files, and builder scripts for Blender, Unreal (CineCamera plus a Level Sequence), Maya and Nuke.
- Verified in Blender 4.3 in both directions: framing matches to IoU 0.995–0.999. See [docs/interop.md](docs/interop.md).

**10:09 PDT · Physics engine interface, plus three-avbd (GPU) as an experimental backend**
- The stage talks to physics through one interface. The default is the CPU XPBD solver.
- [three-avbd](https://github.com/sbobyn/three-avbd) (SIGGRAPH 2025 AVBD on WebGPU) is available as an experimental live backend where WebGPU exists.

**03:07 PDT · Polish** *(Milestone 8)*
- Car glass reads as glass, so actors seated in cars are visible in Clay, Color and the LTX guides.
- The FLUX 3 Klein model label is never cut off.
- Ripple mode hides the audio buttons.
- Voice Change's seed picks the take.

**02:13 PDT · Stage physics** *(Milestone 7)*
- Props drop, tumble and get knocked over by cars and people. **Simulate & bake** writes ordinary, editable keys, so renders stay repeatable.
- The car-shot "clean street" is an experimental option.

**01:09 PDT · Ripple edit and Pose follow** *(Milestone 6)*
- **Ripple:** change frame 1 in Paint Studio, and LTX Ripple carries the edit through the whole clip, keeping the motion and sound.
- **Pose follow** (experimental): LTX follows the stage's skeletons or DWPose from a real clip.

**00:47 PDT · ScriptSync, like Avid's**
- Take thumbnails sit on the lined script. Click a line and the take plays, cued to it.
- You can edit the lining by hand, with undo.

## 2026-10-30

**23:07 PDT · Realism** *(Milestone 5)*
- First frames show real people, not plastic clay figures.
- Fewer phantom cars in car shots.

**21:49 PDT · Model files and horses** *(Milestone 4)*
- Workflows find the build of each model you already have (bf16, fp8, int8) and say so.
- The rigged horse loads again.

**21:05 PDT · Seated cast** *(Milestone 3)*
- Scene setup seats the cast in cars and up on their horses, and the prompts count them where they sit.

**20:23 PDT · First run** *(Milestone 2)*
- A guided tour, a "Let's make a shot" card (demo scene, import a script, import a video), one top row and plain names.

**19:23 PDT · One giant canvas** *(Milestone 1)*
- The canvas is the workspace. Every step's settings float on it: no page scrolling. Press H or Tab to hide the panels.

**13:28 PDT · FLUX 3 Klein is the default image model; Import video → 3D**
- Drop a clip on the stage to rebuild it as a 3D set, or capture its motion.

**08:29 PDT · Contest submission**
- The version submitted to Comfy Org's *Open Source Higgsfield* challenge, built in 3 days.
