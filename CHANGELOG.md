# Soundstage changelog

Soundstage is updated continuously on `main`. Newest first. Times are US Pacific.
Each entry links to the code; every milestone ships with tests.

## 2026-10-31

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
