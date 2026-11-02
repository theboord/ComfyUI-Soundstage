# Soundstage changelog

Soundstage is updated continuously on `main`. Newest first. Times are US Pacific.
Each entry links to the code; every milestone ships with tests.

## 2026-11-01

**18:35 PST · Secondary simulations and soft bodies: one dust / debris / smoke system, and cloth, ropes, cardboard and sand that react to the set** *(Milestone 28)*
- **One particle system for every secondary (POP / Pyro-lite).** Hits, breaks (and Milestone 27's fracture events via `scene.physics.breaks`), foot and hoof strikes and tyre smoke / wet spray all feed one seeded solver that steps the whole shot at a fixed step and caches it, so a frame is always the same picture. Debris is instanced chunks, grains, droplets and splinters that inherit the struck body's velocity, fall with drag, bounce with friction on the ground and the set's boxes, settle and sleep. Dust is a billboard with density (noise atlas, spin, top-lit), slowed by drag towards the wind, carried by curl-noise turbulence, rising on buoyancy, hugging the ground and thinning as it fades. It replaces the Milestone 21 puffs, the gait dust and the Milestone 13 tyre smoke ([particles.mjs](web/stage/particles.mjs), [secondary.mjs](web/stage/secondary.mjs)).
- **Ground types** in the Physics panel: desert sand, concrete dust, wet spray, wood splinters (Auto follows the set and the weather). It shows in Clay and Color only, never in Depth or the ID matte; a new **dust matte** pass (`renderFrameTo("dust")`) holds the dust out behind solid objects, for the Layer Pack.
- **Vellum-style soft bodies on XPBD** ([softbody.mjs](web/stage/softbody.mjs)): **cloth** (tarp, flag, curtain, a clothing panel that rides a person) with pins and gusty aerodynamic wind; **ropes and cables**; a **rope bridge**; **cardboard** that buckles, creases on seeded weak lines and stays crushed (bending and squash plasticity); **sand and gravel piles** that slump and spill (grain contacts, static friction, sleeping). They collide with props, people, vehicles (a raked nose and four tyres, so a car runs a box over instead of bulldozing it), broken pieces and the set, and bake into a vertex cache that every pass plays back (rebuilt the same way after a reload). Physics panel: soft-body type, wind, gusts, stiffness, yield, friction, pins, attach-to ([softpanel.mjs](web/stage/softpanel.mjs)).
- **Presets › Action:** Tarp in the wind, Rope bridge, Cardboard box crush, Sand pile ([softpresets.mjs](web/presets/softpresets.mjs)).
- **Honest limits:** in a Draft of the combined shot (car through the crates, a tarp in the wind, a sand pile in its path) LTX painted the crate burst and the scattered boxes, but almost none of the dust, no sand pile, and the tarp as a still banner. Sand grains are 3.5 cm beads (slumps to about 28°, real dry sand stands at ~32°); no cloth self-collision; one-way coupling (rigid bodies don't feel the soft ones). Evidence: share/Milestone28_SecondarySims. Tests: [tests/js/secondary.test.mjs](tests/js/secondary.test.mjs) (determinism, constraint stability, settle, plasticity, spill).

**17:10 PST · Riders run, climb on and gallop: running legs before a timed mount, a real 1 s mount on horses, gait-blended cadence**
- **Why:** the horse hero shot "looks horrible… they're not even running": riders glided to the horses, the mount was a cut, the gallop slid.
- **Running to the horse.** A rider with a timed `mount_at` was reset to a standing pose every frame before the hop, wiping the gait's legs, so the clay (and the Pose pass) glided on straight legs. A keyed rider now keeps its foot-locked run until the mount starts ([stage.mjs](web/stage/stage.mjs)).
- **Mounting a horse** is now a climb, not a 10-frame hop: near foot into the left stirrup with hands to the saddle, spring up to stand in it, off leg swung back and over the croup, settle into the ride pose, 24 frames (`Gait.mountMotion`, [gait.mjs](web/stage/gait.mjs)). Other mounts keep the hop.
- **No hoof slide through canter → gallop.** The cadence is set from the blended stance share and the blended clip sweep, so a planted hoof covers the body's travel mid-change, not only at each gait's own weight of 1.
- Hero v3 (share/HeroGIF_v3): side-on camera-car track, 50 mm at 1 m; Pose follow (union-control IC-LoRA) on a guide of the stage skeletons over dimmed depth with the horses' silhouettes lifted (their legs no longer melt into the ground's depth). Tests: tests/js/gait.test.mjs (mount keys, cadence vs sweep).

**16:20 PST · Clay → first frame → video, all on the blocking: a locked ④ Frame, a first-frame check that re-rolls ghost cars, and blocked head turns**
- **Why:** "There's a red car behind that car, like ghosting… the FLUX frames aren't adhering to the blocking" and "heads turn in the final render that aren't in the blocking."
- **④ Frame starts from the stage.** FLUX 3 Klein used to see the Color pass only as an edit reference and paint from noise, so it recomposed the shot (the car-chase hero car, 58 % of the frame wide on the stage, came out small and far). Now the latent starts from the Color pass shrunk 16x and blown back up (where things are, how big, what colour; no clay surface to copy) at `stage_denoise` 0.90, which **Follow the clay** sets for Klein. A sharp start was tested and rejected: at 0.75 Klein kept the clay mannequins. No depth or edge control exists for Klein on the pod, so none is used (nothing downloaded).
- **The prompt states what frame 1 holds, measured on the ID pass:** "a sports car in the centre of frame, close to the camera, two thirds of the frame wide; a police car in the right third, small in the distance, a tenth of the frame wide" (the old guess from the camera said "seen whole in the middle distance").
- **First-frame check on every candidate** (*Soundstage · First Frame Check*, SAM 3.1 against the stage's ID pass): object count per kind, silhouette IoU per actor, extra objects outside every stage silhouette (a ghost car), missing or off-mark actors. A badge on each candidate (✓ Matches clay 78 % · ≈ Loose · ⚠ an extra car); flagged frames are re-rolled automatically (twice per Generate at most) and never become a shot's automatic pick while a clean one exists.
- **Measured** (same seeds): car chase sports car silhouette IoU 0.07 → 0.29 and police car 0.56 → 0.73 (still *Loose*: the car sits right of its mark and smaller; at 0.85 it reached 0.58 but the police car fell to 0.18); the two-person gaze shot 0.78 (Ben 0.71, Ellie 0.85), real people, no mannequins. The old riders frame already matched (0.60 / 0.65); the old walk frame is flagged (Ellie off her mark, IoU 0.05).
- **Head and gaze blocking** (`web/stage/gaze.mjs`): gaze keys per person (another actor, the camera, a prop, left / right / up / down, or ahead), eased turns that start at the key, eyes first then head + neck to 80°, the chest beyond, pitch limits. With no keys the head holds steady facing the travel direction (the idle "look around" sway is gone; the walk's chest twist is cancelled in the neck). Pose panel › Interact: Look at, Look into the camera, Look left / right / down, Look ahead again, Clear head turns. The clay head (brow, nose, ears) reads the turn.
- **The prompt says every head, positively:** "The man keeps his head steady, facing ahead; at 2.0 s he turns his head toward the woman and holds it there. The woman holds her head still, facing the same way throughout." Drivers "keep their eyes on the road". The Director (`gaze` tool: "Ben looks at Ellie at 2 s") and Pitch ("she looks into the camera at 2 seconds", "he keeps his eyes on the road") set gaze keys.
- **Verified in a draft:** Ben's blocked turn toward Ellie starts at 2.0 s and lands by 2.5 s, as in the clay; Ellie, unblocked, holds her head still for all 4 s. Flaw: LTX added a blurred pedestrian in the deep background.
- Evidence: share/FirstFrame_Gaze/ (REPORT.txt, sheets, draft, checks). Code: [soundstage/look/frame_lock.py](soundstage/look/frame_lock.py), [soundstage/router/adapters.py](soundstage/router/adapters.py), [soundstage/takecheck/framecheck.py](soundstage/takecheck/framecheck.py), [soundstage/nodes_takecheck.py](soundstage/nodes_takecheck.py), [web/pipeline/framecheck.mjs](web/pipeline/framecheck.mjs), [web/stage/gaze.mjs](web/stage/gaze.mjs), [soundstage/look/gaze.py](soundstage/look/gaze.py). Tests: [tests/test_frame_gaze.py](tests/test_frame_gaze.py), [tests/js/gaze.test.mjs](tests/js/gaze.test.mjs).

**16:16 PST · The realism judge: a VFX-supervisor pass that calls out AI slop**
- **Hollywood takes are judged automatically.** A local vision model (Qwen3-VL 8B via TextGenerate, through the queue, about a minute) samples 6 frames, finds the cars, people and animals, crops them at full resolution and checks them against a checklist for their kind: matched lamp pairs, no stray lamps, crisp exhaust, diffuser and grille, round wheels in their arches, one coherent design; one face, five separate fingers, the right limbs. A red **✗ AI slop: rear lights incoherent, f10–110** chip on the Ladder and in Dailies, with the defects on hover. A failed Hollywood take gets **one** automatic re-roll offer per shot. A **Judge** button works on any draft or final; MCP clients get `soundstage_judge_take`; reports can run `python -m soundstage.takecheck.realism take.mp4`.
- **Calibrated on the Hollywood re-renders.** Both J-turn takes Mike rejected fail; the underwater and train takes pass (9.5–10/10). A defect counts only when it repeats in at least half the sampled frames. Fingers and faces count only when the locate pass can see them and the person is big on screen. Each subject kind gets its own checklist, because one shared list made the model find "exhaust tips" on a diver.
- **Limit:** it fails every AI car so far, including the improved J-turn below. On a car, the red chip means "inspect", not proof.
- **Why the J-turn car melted:** the stage-2 refine isn't the cause. The bad rear (two white lamps low, a melted diffuser) is already in the first-frame look reference and in the stage-1 decode, because the look text asked for a full-width light bar while the sports-car GLB in the guide has two C-shaped lamps. Fixing that conflict (a Klein still from the colour guide with words that match the GLB, used as the reference) gave a coherent rear. Evidence: share/Realism_Judge/REPORT.txt.
- Code: [soundstage/takecheck/realism.py](soundstage/takecheck/realism.py), [soundstage/takecheck/routes.py](soundstage/takecheck/routes.py), [web/takecheck/](web/takecheck/), [tools/soundstage_mcp.py](tools/soundstage_mcp.py). Tests: [tests/test_realism.py](tests/test_realism.py), [tests/js/realism.test.mjs](tests/js/realism.test.mjs).

**15:47 PST · Rotation you can find: a Move · Rotate · Scale bar on the selected object, a yaw ring to grab, 3-axis Rotate, Shift snap**
- **Why:** "There's no way to rotate any object in the canvas." Turning worked (R + the gizmo ring, the Properties Turn slider), but only behind a key and an icon-only button; the ring was a thin Y-only circle, and Alt + drag from a press orbited the camera instead of turning.
- **Now:** a selected prop, car, person or set piece gets a floating bar (Move G · Rotate R · Scale T, Reset rotation) and a yellow ring at its feet you drag to turn it; Alt + drag on an object turns it from the press; R turns on all three axes (tilt and roll, stored as heading + tilt); Shift snaps to 15°. One undo step per turn. In the "?" sheet and the Guide. [`web/stage/rotate.mjs`](web/stage/rotate.mjs), tests in [`tests/js/rotate.test.mjs`](tests/js/rotate.test.mjs).

**15:46 PST · Full control over every object: doors, lamps, light bars, steering, suspension, horse heads, light flicker, lens channels** *(Milestone 26)*
- **Properties › Parts** for whatever is selected: every channel with its control, its value and a key button (◆ key here, ◇ animated, ○ not), ‹ › to jump between its keys, ✕ to clear, Shift+click for ease / linear / step, **Auto-key** and **Key all** (K). An edit to a channel that isn't animated sets it for the whole shot; once it has keys, an edit keys the playhead (as in Sequencer and Maya). One undo step per change. Animated channels show as rows under the object on the timeline (drag to retime, double-click to add, right-click to delete).
- **Cars and the truck:** steering (the front wheels turn; automatic along the path until keyed), ride height / roll / pitch on top of the weight transfer, **every door, hood and trunk open/close** (the models are one body mesh, so the doors are separate panels measured off the body with rays, in the body's paint, with a dark aperture), headlights off / dipped / full beam (real spot lights), brake lights (automatic while slowing), indicators and hazards (1.5 Hz), the **police light bar** (a deterministic red/blue wig-wag that washes the street), wipers, window tint, paint finish, dirt and a keyable **damage** crumple. The procedural sedan and truck now have wheel pivots and a sprung body like the real models. Bikes steer; boats and the airliner get nav lights and strobes.
- **Lit lamps glow in the clay guide** (kept out of the clay override), so the guide LTX follows shows headlights, brake lights and the light bar; open doors are real geometry in clay and depth.
- **Horses:** head up/down and turn, neck arch, tail lift and swish (offsets on the rigged horse's bones about its own axes), and a gait override. **People:** expression presets (keyed, into the prompt), eyes (gaze keys) and props in hand right in Parts, and a button to Pose Studio's hands. **Props:** a pivot point (Maya-style), finish and glow, and rotation of an imported model's named parts.
- **Film lights over time:** intensity, colour temperature, cone and softness keyable; flicker (candle, failing fluorescent, TV, lightning, strobe, police, pulse), deterministic per frame; practical (a lit bulb in the guide) / motivated / film light. **Camera › Lens channels:** focal length, focus distance, T-stop, roll, shutter angle and sensor (Super 35, LF, ALEXA 65, IMAX...), all keyable.
- **Director / MCP `part` tool:** "open the driver's door at 2 s", "turn on the police lights", "headlights on full beam, hazards on", "the horse throws its head up", "Mara smiles at 3 seconds", "make the lamp flicker like a candle" (MCP: `ss_part`). Keys: L headlights, Shift+L light bar, I indicators, O driver's door (Shift: every door), K key all; in the "?" sheet and the tooltips.
- **Prompts say the visible state and when it changes:** "The police car has headlights on full beam and red and blue roof lights flashing." "At 2.0 s the police car's driver door swings open."
- Gap list (what a Sequencer / Maya / C4D previs artist expects, what's built, what's still missing), before / after screenshots and a recording of the controls: share/Milestone26_FullControl/.
- Code: [web/stage/objparts.mjs](web/stage/objparts.mjs), [web/stage/vehicleparts.mjs](web/stage/vehicleparts.mjs), [web/stage/rigparts.mjs](web/stage/rigparts.mjs), [web/stage/lightrig.mjs](web/stage/lightrig.mjs), [web/stage/partspanel.mjs](web/stage/partspanel.mjs), [soundstage/look/objstate.py](soundstage/look/objstate.py), [soundstage/agent/parts.py](soundstage/agent/parts.py); hooks in [web/stage/stage.mjs](web/stage/stage.mjs), [web/stage/tracks.mjs](web/stage/tracks.mjs), [web/soundstage.js](web/soundstage.js), [web/agent/director.mjs](web/agent/director.mjs), [soundstage/agent/director.py](soundstage/agent/director.py), [soundstage/look/compile.py](soundstage/look/compile.py). Tests: [tests/js/objparts.test.mjs](tests/js/objparts.test.mjs), [tests/test_parts.py](tests/test_parts.py).

**15:17 PST · Stunt cars round 2: a stunt-sprung body that rocks, a floored launch with a fishtail, a donut held in closed loop, slip-energy smoke and spray** *(Milestone 13, round 4)*
- **Stunt suspension** (the stunt presets' default; `suspension: "stock"` gives the road car back): roll gradient ×1.6 (anti-roll bars off), about 1 Hz, ζ 0.16; pitch ×1.9; bump stops at 8.5° roll and 5° pitch; a 52° angle kit. The J-turn on wet now leans **7.0°** in the flick (was 3.6°) and rocks 7 → 2.5 → 5 → −1°. Dry leans 10.5° onto the bump stops.
- **The launch:** first gear and full throttle as the nose comes round, with about 6 m/s of wheelspin allowed. The driver reacts 0.14 s late, so the tail fishtails +6.9° / −0.9° and settles. It reaches 30 km/h 0.58 s after the nose is round (was 0.96 s). The wet road still caps it at about 0.25 g.
- **Donut:** a cascaded controller. The yaw-rate PI sets the rear-tread spin, the throttle chases that spin, and the wheel tracks the front axle's slide. It holds a steady rotation (85–90 °/s, cv 0.1) with the rears smoking the whole time, and does 2 turns (705–795°) in a 10 s shot. In a 5 s shot it holds to the last frame (325°) instead of stalling at 300°.
- **Handbrake 180:** a feint away, full lock in 0.1 s and the handbrake together. The handbrake comes off at 130°, or as soon as the slide dies, and it drives out in first under power. Dry: 1.92 s, then 35 km/h. Wet: 2.42 s, and it only crawls away at 8 km/h.
- **Smoke / spray from the slip energy** (μ·Fz × slip speed). Dry gives rising smoke that lasts 1.6–2.8 s. Wet gives low, short, cool-white spray thrown back off the tread.
- Code: [web/stage/vehsim.mjs](web/stage/vehsim.mjs), [web/stage/stunts.mjs](web/stage/stunts.mjs), [web/stage/environments.mjs](web/stage/environments.mjs), [web/stage/stage.mjs](web/stage/stage.mjs). Tests: [tests/js/vehsim.test.mjs](tests/js/vehsim.test.mjs) (6 new), [tests/js/stunts.test.mjs](tests/js/stunts.test.mjs). Evidence: share/Stunt_Dynamics/round2/.

**15:09 PST · People run and horses gallop on planted feet (foot-locked gaits) and kick up dust**
- **Keyed people walk, jog and run on their feet** (`web/stage/gait.mjs`): the path's speed picks the gait and sets cadence and stride; every step is planted on one spot (heel strike, flat, toe-off) and the legs reach it by two-bone IK (mocap.mjs `legIK`, feet on `_supportAt` ground), so a stance foot never slides. Arm swing against the legs, hip and chest counter-rotation, pelvis rise and fall, a head nod, leaning into turns and into acceleration. Starting and stopping are real steps: the stride only stops once both feet are down under the body. Applies to keyed movement in every render, not only live drags; a vault or jump keeps its tuck.
- **Horses: walk, trot, canter, gallop by speed.** Each leg of the rigged horse is posed from its own moment in the Walk / Gallop clips, so the clips' leg shapes play out true footfalls (four-beat walk, diagonal trot, three-beat canter, transverse gallop); the cadence is set from the clips' own hoof sweep so planted hooves cover exactly the ground the body does, and a small hinge correction pins them. **Riders** sit on the moving back: sit the walk, post the trot, swing with the canter, two-point over the neck at the gallop (leaning from the seat, soaking up the bound).
- **Dust at every foot and hoof strike:** seeded (same frame, same particles), scaled by speed and by the set's ground (desert dustiest, asphalt barely, interiors none), fading near the camera; Clay and Color only, never Depth or the ID matte.
- Tests: `tests/js/gait.test.mjs` (gait by speed, planted foot slide < 1 cm/frame for walk, jog, run and a turn, start/stop steps, horse footfalls, deterministic dust).
**14:40 PST · Car stunts are driven, not hand-keyed: a vehicle-dynamics simulation under the J-turn, handbrake 180 and donut** *(Milestone 13, round 3)*
- **Why:** the old J-turn scrubbed 13 m/s to nothing in about a second on a wet road. That is about 1.3 g, twice what wet tyres give, and it spun 180° in 0.7 s. It read as a video game.
- **The car:**
  - **Model:** a planar four-wheel car (mass, yaw inertia, wheelbase, CG height, track). Every wheel spins on its own, so a wheel locks under the handbrake and spins up on a launch.
  - **Tyres:** Pacejka Magic Formula on combined slip, with a friction ellipse. Wet μ 0.62 and dry μ 0.9, using the published B, C, E sets.
  - **Body:** longitudinal and lateral weight transfer. The sprung body's roll (6 °/g, 1.3 Hz, ζ 0.25) and pitch are damped oscillators that feed the transfer, so the car leans, wobbles and settles.
- **The presets are now driver scripts:** throttle, brake, handbrake, steer and gear, at set times or when the car has turned far enough. The path, heading, roll, pitch and tyre slip are baked into a key every 2 frames. Smoke comes from the real slip.
- **Selected car › Stunt** has **km/h**, **Road (Wet / Dry)** and **kg**. Changing one re-runs the stunt from the same start.
- **J-turn at 40 km/h on a wet road:**
  - The 180° takes 1.7 s (it was 0.7 s), and the car slides 18.7 m (it was about 9 m).
  - Yaw peaks at 100 °/s, the body slips to 90° (side-on), and it leans 3.6° (6.6° on a dry road).
  - Prompts now say "slides around 180 degrees in one long, scrubbing arc … rocking on its springs".
- **Donut:** the simulated driver doesn't hold a steady donut yet. It does about one turn (≈290°), not two.
- Evidence: share/Stunt_Dynamics/ (RESEARCH.md with sources, before|after clay, sheets, the Draft).
- Code: [web/stage/vehsim.mjs](web/stage/vehsim.mjs), [web/stage/stunts.mjs](web/stage/stunts.mjs), [soundstage/look/stunts.py](soundstage/look/stunts.py). Tests: [tests/js/vehsim.test.mjs](tests/js/vehsim.test.mjs), [tests/js/stunts.test.mjs](tests/js/stunts.test.mjs), [tests/test_stunts.py](tests/test_stunts.py).

**13:41 PST · Pitch Mode: talk through the idea, the set builds itself, a sketch per beat** *(Milestone 22)*
- **● Pitch** in the Director panel (or Shift+P): the mic stays on and every sentence, ellipsis or "then" is a beat. Each beat stages the set live (place and set, time, weather, a character and wardrobe, blocking relative to the camera: walks toward / runs away / crosses, a car's headlights sweeping across, props, camera height, rig, follow and lens). "He" / "she" mean the last person of that kind. One Director undo step for the whole pitch, **Undo beat** for the last one.
- **A FLUX 3 Klein sketch per beat** (Color pass capture, 4 steps, 0.3 MP, ~1.6–1.9 s on the GPU) lands in a filmstrip next to the live transcript, with a latency HUD. **Preview motion** queues a one-pass LTX-2.5 draft (512×288, 49 frames) of a beat. **Lock it** makes one shot per beat (its camera and rig, the line as notes, the sketch as the chosen first frame).
- **Shared-queue safe:** Pitch only deletes prompt ids it queued itself, only while still waiting (a re-staged beat's old sketch, or a backlog when you talk faster than the GPU); it never interrupts. Klein is warmed at Pitch start. Whisper windows end at a pause and carry a film-words prompt (`X-Soundstage-Prompt`) so "a rainy alley" isn't heard as a name; the local Qwen per beat is opt-in under ⚙ (2–6 s a beat on a shared queue).
- Measured live (macOS `say` pitch into the Whisper stream, headless Metal): transcribe 0.26–0.78 s, plan 0.12–0.31 s, capture + upload ~0.3–0.5 s, Klein 1.6–1.9 s; end of sentence → image 12–22 s in the recorded take because other jobs on the shared GPU and a cold Klein load ran mid-pitch (the HUD says so).
- Evidence: share/Milestone22_Pitch/ (pitch_mode_live.mp4 with the spoken pitch, sketches, latency.md/csv, motion draft, locked shots).
- Code: [web/agent/pitch.mjs](web/agent/pitch.mjs), [soundstage/agent/pitch.py](soundstage/agent/pitch.py), [web/agent/directorpanel.mjs](web/agent/directorpanel.mjs), [soundstage/agent/director_routes.py](soundstage/agent/director_routes.py), [soundstage/agent/whisper.py](soundstage/agent/whisper.py), [docs/director.md](docs/director.md). Tests: [tests/js/pitch.test.mjs](tests/js/pitch.test.mjs), [tests/test_pitch.py](tests/test_pitch.py).

**13:20 PST · Physics round 2: the live world's friction fixed, car hits no longer sink into crates**
- **Live drag world, same friction fix as the bake.** Its sliding friction also divided by the inverse mass twice (a 2 kg box on a 30° ramp slid at 2.52 m/s² instead of 0.657). It is now Coulomb with one mu, within 10% for 2 and 25 kg.
- **The jittered 20-carton tower stands.** With the fix it crept 2.2 mm sideways (limit 2 mm) before it fell asleep. The live world now runs 6 contact passes, not 4: 0.9 mm, for about 8% more step time. The limit is unchanged.
- **Speculative contacts for keyed movers (cars, horses).** In the bake and the live world, contacts with a moving keyed body are made ahead by the distance it moves in a substep (capped at 6 cm). A probe beside the box that is outside another face is skipped, so a car's corner no longer flings a crate at 30 m/s. Car through the pyramid: overlap p95 is 0.6 mm (was 5.8; Bullet 1.7) and the max is 6.0 mm (was 11; Bullet 7.2). No crates are left riding on the stopped car's roof (final energy 981 J, Bullet 981 J). The tower is unchanged.
- Report: share/Physics_vs_Blender/REPORT.txt ("after round 2" column). Code: [web/stage/physics.mjs](web/stage/physics.mjs). Tests: [tests/js/physbench.test.mjs](tests/js/physbench.test.mjs).

**12:58 PST · Physics benchmarked against Blender's Bullet: friction fixed, towers stand still**
- **Friction no longer depends on weight.** The bake's sliding friction divided by the inverse mass twice, so a 2 kg box on a 30° ramp (mu 0.5) slid at 2.53 m/s² instead of 0.657, and a heavy crate gripped the floor so hard it stopped dead against a tower. It is now plain Coulomb friction with one mu (the 0.85 kinetic factor is gone, as in Bullet and Houdini): the ramp is within 1% of g(sin θ − μ cos θ) (Bullet: −10%).
- **Stacks stand still before the hit.** The bake now uses 4 contact passes (like the live world), not 2: an untouched 20-box tower bowed 16 cm in 3 s; now 9 mm (Bullet: 45 mm), at about the same bake time.
- **Benchmark you can re-run** (Blender now, Houdini later): `tools/physbench/` (four scenes, runners for Soundstage and headless Blender, metrics, charts, Workbench and clay contact sheets). Report: share/Physics_vs_Blender/REPORT.txt. Still behind Bullet on speed (15-60x slower) and on overlap in fast car hits (11 mm vs 7 mm).
- Code: [web/stage/physics.mjs](web/stage/physics.mjs), [tools/physbench/](tools/physbench/). Tests: [tests/js/physbench.test.mjs](tests/js/physbench.test.mjs).

**12:50 PST · Renders that stay on your blocking: Adherence Loose · Balanced · Exact, default Exact**
- **Why finals drifted off the clay:** the old "Motion freedom" default (0.5) blurred the clay guide 10 px and dropped the Layout IC-LoRA to 0.825, and your chosen frame steered at full strength, so where the frame's composition differs from the clay (it often does: the look still is made from frame 1 at 0.85 denoise) the opening follows the frame for a second before snapping to the clay.
- **⑤ Motion › Adherence** replaces the Motion freedom slider, saved per shot. **Exact** (the new default for Draft, Final and Hollywood): sharp clay guide, IC-LoRA 1.0, frame reference 0.5. **Balanced**: 6 px, 0.92, 0.75. **Loose** = the old default. Measured on the car chase, the riders and a two-person walk (same seed, Loose → Exact): the walk 0.91 → 0.99 "Follows your blocking", the riders' people 61-69 % → 90-94 % on their marks, the car-chase final 0.69 → 0.79 and the car fills its clay silhouette from 1 s on; still photoreal.
- **Advanced (LTX) › Blocking:** the raw Layout IC-LoRA, clay guide blur and frame reference strength. Measured limits: IC-LoRA 1.2 adds nothing; reference below 0.4 turns the render clay-grey; the guide strength itself must stay 1.0 (the node caps it there).
- **Color pass as the guide** (Mike's question) tested and **not adopted**: blocking is equal on the car (0.55 vs 0.55 IoU) and worse on Ben in the walk (0.54 vs 0.70), and it looks worse: flat toy paint and unlit headlights copied from the pass. Color × clay shading: equal blocking, darker and more matte. Clay stays the guide.
- **Follows your blocking %:** an actor SAM loses and picks up again as a new track is no longer scored as off its mark.
- Evidence: share/Blocking_Adherence/ (REPORT.txt, clay | before | after video, contact sheets with the stage silhouettes, every take).
- Code: [soundstage/ltx_settings.py](soundstage/ltx_settings.py), [soundstage/nodes_quality.py](soundstage/nodes_quality.py), [soundstage/takecheck/routes.py](soundstage/takecheck/routes.py), [soundstage/takecheck/blocking.py](soundstage/takecheck/blocking.py), [web/motion/ltx_presets.json](web/motion/ltx_presets.json), [web/motion/ltxadvanced.mjs](web/motion/ltxadvanced.mjs), [web/pipeline/pipeline.mjs](web/pipeline/pipeline.mjs). Tests: [tests/test_ltx_settings.py](tests/test_ltx_settings.py), [tests/js/ltxadvanced.test.mjs](tests/js/ltxadvanced.test.mjs), [tests/test_takecheck.py](tests/test_takecheck.py).

**12:35 PST · Real performances: an actor's body, face and voice drive your character** *(Milestone 25)*
- **Real performance…** on a selected person, next to Act it out. Record on the webcam and mic, film on your phone and Import, or bring any clip. DWPose reads the body, both hands and **68 face landmarks** on every frame, and the voice is kept. Preview the skeleton and face over the actor, with a mouth-open curve, then **Apply to shot** and render Draft · Final · Hollywood. The take lands in Takes. **Keep the real footage** hands the clip to Ripple edit instead.
- **The render** (`SoundstagePerformance`) is Mike's tested union-control graph (LTX-2.5 + `ltx-2.3-22b-ic-lora-union-control-ref0.5`, OG audio in the sampler). The guide is the actor's body + face, fitted onto the character's place in the shot. The voice drives the sampler through the **0.3 audio noise mask** (the frozen-mouth fix) in both stages. The result carries the actor's own voice.
- **Measured** on a generated talking head driving a different character: mouth-open correlation with the actor **0.92** (Hollywood) / 0.86 (Draft), 0-frame lag, mouth openings within ±1 frame. The wow, the brow lift and the smile land on the same frames.
- **Consent:** a performer name and a consent tick are required, stored with the asset. Assets are private (`output/soundstage_private/performances/`).
- **4D Gaussian splats:** not built. SplatKit's 4DAnyone is on the pod, but it has a Windows-only backend and none of its ~19 GB of models are there, and it re-angles the same actor rather than making a character act. Recommendation and comparison in [docs/performance.md](docs/performance.md).
- Evidence: share/Milestone25_Performance/ (source | result side-by-sides, mouth-crop sheets, lip-sync numbers, UI screenshots).
- Code: [soundstage/nodes_performance.py](soundstage/nodes_performance.py), [soundstage/performance/](soundstage/performance/), [web/performance/performance.mjs](web/performance/performance.mjs); hooks in [web/soundstage.js](web/soundstage.js), [soundstage/nodes_stage.py](soundstage/nodes_stage.py). Tests: [tests/test_performance.py](tests/test_performance.py), [tests/js/performance.test.mjs](tests/js/performance.test.mjs).

**12:31 PST · Breakable, deformable props: crates splinter into planks, cardboard dents and tears** *(Milestone 24)*
- **Pre-fractured props.** Every crate is split, seeded and deterministic, into the boards it is made of (wood: 1-3 planks per face, up to 8 parts) or, in cardboard, the bottom, four walls and two lid flaps. The parts are glued with breakable joints; a joint snaps when a hit forces more than the material's glue strength through it (wood 5.5, cardboard 7 m/s of velocity change, ±15% per joint), with the load falling off with distance from the hit, so a crate breaks where it is struck and the rest can hold as an open crate that breaks again later.
- **Debris inherits the motion:** each group of parts still glued becomes its own rigid body with the parent's velocity at its centre (v + ω × r), its spin, and a seeded kick by how far the load passed the glue. Broken boards grip the asphalt harder and bounce less, so debris comes to rest instead of skating. A break logs a break event (more dust and chips from the raw edges; the prompt beat says the crates "burst apart into loose planks and splintered boards").
- **Cardboard dents** below its break strength: a permanent push of the clay mesh on the struck side, scaled by the hit (a crushed box stays crushed), stored per object as a dent list and shown from its frame on.
- **Baked as ordinary keys:** pieces as keys from the frame before the break (the whole prop shows until then), dents per object. Physics panel: **Breakable** (scene switch, on by default); a crate's Material set to Cardboard makes it a carton. Bake cost is capped (8 parts a prop, 64 extra bodies a bake; corner-only floor contacts and a sort-and-sweep broad phase): the crate crash bakes in about 2 s on an idle Mac.
- **Proof** (the Milestone 7/21 crate crash, same look, same Frame model + seed so frame 1 matches M21): the crates burst at the hit and boards lie on the street afterwards. Evidence: share/Milestone24_Breakables/.
- Code: [web/stage/fracture.mjs](web/stage/fracture.mjs), [web/stage/physics.mjs](web/stage/physics.mjs), [web/stage/stage.mjs](web/stage/stage.mjs), [web/stage/impacts.mjs](web/stage/impacts.mjs), [web/stage/physpanel.mjs](web/stage/physpanel.mjs), [soundstage/look/impacts.py](soundstage/look/impacts.py). Tests: [tests/js/fracture.test.mjs](tests/js/fracture.test.mjs), [tests/test_look_impacts.py](tests/test_look_impacts.py).

**12:10 PST · The Director's Book: a page per scene, your shorthand filed by the model, a PDF binder** *(Milestone 23)*
- **Book** (top bar, or ① Script's Director's Book / Book page) opens a binder laid out like real directors' prep books. The whole film gets a one-line **Spine** (Kazan), a director's statement, rules and style words. Each scene gets a **Coppola cover sheet** (Synopsis · The Times · Imagery & Tone · The Core · Pitfalls) plus between the lines, lighting design, performance per character, a **Hitchcock-style sound lane** (what we hear and why, silence included), and continuity and props across scenes.
- **Off the stage:** a numbered **shot strip** (1A, 1B…) with clay or chosen frames and move arrows. A dropped shot is struck through, never deleted. The **camera plan** (lens, height, move, rig) is read from each shot's keys, ride-along cameras included. The **floor plan** is top-down: actor circles, 1 → 2 marks, dashed moves, and lettered camera cones. The **lined-script strip** shows story day, time, planned / shot / cut. **Lock revision** cycles White, Blue, Pink…
- **Drafted by the local Qwen3.5 4B** from the scene text and its stage. The server checks every sentence against the script: sentences that name things the script doesn't mention are dropped, and plot words the scene doesn't contain are flagged ("steals"). The writer's own synopsis is kept. Fields say *yours* / *AI draft* / *from the stage*, and your edits are never overwritten.
- **Your notes, in your shorthand.** Write any outline; the model files each line on its scene, line, character and department, with a confidence and a one-line "why here". On the Dry Creek demo: "sc2 — keep Mara's face in shadow…" goes to sc 2 · Lighting · Mara; "chase: low & fast, no music till the crash" goes to sc 2 · Camera + Sound, on the police car line; "Ezra never looks Cole in the eye" goes to sc 1 · Performance · Ezra. Notes are pinned in the script page's margins (layers per department) and in ① Script. Drag them to another scene or line; anything unplaceable waits in **Unsorted**.
- **Living memory:** `node.ssBook.context()` / `getBookContext()` (and `GET /soundstage/book/context`) feed the Director's prompt on every command. Decisions made in chat come back as notes. Imagery & Tone and the Pitfalls go into the still and motion prompts, written as positive words because CFG 1 ignores negatives ("avoid melodrama" → "restrained, understated performance").
- **Export:** a typeset PDF binder (cover, statement, contents, three pages per scene, revisions, About with the sources) through the browser's print, and Markdown.
- Evidence: share/Milestone23_DirectorsBook/ (the PDF, screenshots, research notes, run log).
- Code: [web/book/](web/book/), [soundstage/book/](soundstage/book/); hooks in [web/soundstage.js](web/soundstage.js), [web/script/panel.mjs](web/script/panel.mjs), [web/agent/director.mjs](web/agent/director.mjs), [soundstage/agent/director.py](soundstage/agent/director.py), [soundstage/look/compile.py](soundstage/look/compile.py). Tests: [tests/js/book.test.mjs](tests/js/book.test.mjs), [tests/test_book.py](tests/test_book.py).

**10:55 PST · Physics shots that read as filmed, not as a video game** *(Milestone 21)*
- **Impact events.** Simulate & bake now logs every hit (frame, position, normal, impulse, speed, both materials) and stores them with the scene (`scene.physics.events`); a car's body and cabin report as the car. Any backend can derive the same events from its tracks (`physengine.impactEvents`). Every layer below keys off them.
- **Dust, debris and sparks in the guide.** Seeded puffs billow off each hit (material-tinted, sized by impulse), chips fly and lie where they land, metal on something hard throws sparks and a brief light flash. Clay and Color only (the guide LTX follows), never Depth or the ID matte. Physics panel: **Material** per object and **Impact FX** Dust · Debris · Sparks.
- **Timed material beats** in the motion prompt: "At 2.5 s the sports car slams into the wooden crates: the crates splinter, planks crack and spring loose, a burst of dust and wood chips; the camera jolts" (cardboard crumples, metal dents, glass shatters). Up to three beats; scenes without hits compile unchanged.
- **Camera shake on impact** a beat after each hit, decaying, scaled by impulse and distance and by the rig (a tripod gets a thump, handheld and car mounts more). Light · Heavy · Earthquake per shot, and an **Impact shake** card in Presets › Action.
- **Film Finish** on the Cut render (a Finish choice beside MP4 / ProRes) and as the **Soundstage · Film Finish** node: slight barrel, colour fringe toward the edges, red halation, vignette, grain last; Off · Subtle · 35mm · Anamorphic; stock ffmpeg.
- **Impact sounds on A2:** the Cut's **Impact sounds** puts one cue on every hit's frame, by material (wood splinters, cardboard crumples, metal rings, glass shards), gain by impulse, from a small library synthesised once on the server (no model, no download).
- **Imperfect** (on by default): seeded ±15% mass, ±12% grip, ±20% bounce per body; the Crate crash preset builds uneven pyramids (crates 86–97% size, off their marks, turned, some leaning). **Overcrank** 1.5× / 2× / 3× (keys stretched, gravity g/k², "slow motion, high-speed camera" in the prompt) and **Feels bigger** (60% gravity).
- **Proof** (the Milestone 7 crate crash: a 1.5× overcrank test draft, the draft, the final): dust clouds and debris now show in the video and hang after the hit, the pile scatters less evenly, and the finish and hit sounds make it feel photographed. Honest: the crates still read as rigid, clean CG boxes that tumble intact (the prompt's splintering doesn't happen because the guide doesn't show it: fracture is the next step), and LTX recoloured the police car in the draft. Evidence: share/Milestone21_Realism/ (before | after grid, guides, REPORT.txt).
- Code: [web/stage/impacts.mjs](web/stage/impacts.mjs), [web/stage/physics.mjs](web/stage/physics.mjs), [web/stage/environments.mjs](web/stage/environments.mjs), [web/stage/physpanel.mjs](web/stage/physpanel.mjs), [soundstage/look/impacts.py](soundstage/look/impacts.py), [soundstage/finish.py](soundstage/finish.py), [soundstage/nodes_finish.py](soundstage/nodes_finish.py), [soundstage/cut/impact_sfx.py](soundstage/cut/impact_sfx.py), [web/cut/impactsfx.mjs](web/cut/impactsfx.mjs). Tests: [tests/js/impacts.test.mjs](tests/js/impacts.test.mjs), [tests/test_look_impacts.py](tests/test_look_impacts.py), [tests/test_finish.py](tests/test_finish.py), [tests/test_impact_sfx.py](tests/test_impact_sfx.py).

**10:25 PST · Motion capture: feet stick to the ground (no more floating or sinking performer)**
- **The bug:** the Video → Stage dancer (the trailer's Video → 3D beat, LTX draft from the clay) read as floating: the clay's height came from the capture's raw feet over its lowest tenth, so monocular depth drift moved her up and down, and with no ankle a bent knee tipped the shoe toe-down into the floor with the heel in the air. Measured on the re-imported clip: lowest sole −9.2 … +3.7 cm (median −3.8), planted feet sliding ~2.5 cm a frame.
- **The fix, as pro mocap cleanup does it** (on by default; **Stick feet to ground** in the Pose panel's take row turns it off): foot contacts from low ankle speed + height over a rolling local ground (single-leg support during kicks, jumps keep their arc); each planted foot laid flat on the walkable surface under it (the floor, a set's own floor, or a step/riser/parked prop top, ray cast down like live drags); the pelvis solved so the lowest planted sole touches; two-bone leg IK pins a planted ankle where it stood mid-contact (no sliding); 3-frame eases at contact ends.
- After: lowest sole 0.0 cm on 191 of 192 frames (max +3.3 cm on one small hop), planted ankles slide 0.0 cm median. The other captures (front flip, heavy-bag kicks, open door, run to camera, throw, wall jump, aerial) all improve; the flip keeps its full arc.
- Evidence: share/Fix_FootContact/ (clay before/after, per-frame cm CSV, all-takes regression).
- Code: [web/stage/mocap.mjs](web/stage/mocap.mjs), [web/stage/stage.mjs](web/stage/stage.mjs) (`_supportAt`), [web/stage/posepanel.mjs](web/stage/posepanel.mjs). Tests: [tests/js/footcontact.test.mjs](tests/js/footcontact.test.mjs).

**10:17 PST · Director chat docks beside the panels: no more covering Properties, Look or Play**
- The Director (/) opened over the bottom of Properties and the Look pop-over and hid the stage's Play, Fit and Hide-top-view controls. It now docks like the Presets window: at the right of the free band between the tool rail and Properties, above the playback row; when that band is too narrow (Look open) it takes Properties' slot while it's open, and Properties is back when it closes. It re-docks as panels open, close or resize.
- Checked headless (Metal) at 1280×800, 1440×900 and 1920×1080 with Properties and the Look pop-over open: nothing under the chat.
- Code: [web/agent/directorpanel.mjs](web/agent/directorpanel.mjs). Tests: [tests/js/director_dock.test.mjs](tests/js/director_dock.test.mjs).

**10:05 PST · QA round 06: switching scenes no longer re-renders hidden previews**
- **Faster scene switch.** ◀ ▶ (or a scene chip) redrew the hidden preview ladder four times and every shot's clay thumbnail once per step row (Frame, Motion, Review, Deliver): 29 off-screen stage renders per switch. Now 4: a hidden ladder waits until its view opens, and each shot's thumbnail is rendered once per redraw. Measured on the demo scene at 1280×800: about 1.9 s before, 1.4–1.6 s after (on the heavily loaded Mac earlier it was 6–8 s).
- Checked in a browser: a full click-through of ③ Set … ⑦ Deliver at 1280×800 and 1920×1080 (about 650 clicks), 0 console errors (share/QA/round_06/).
- Code: [web/ladder/ladder.mjs](web/ladder/ladder.mjs), [web/pipeline/pipeline.mjs](web/pipeline/pipeline.mjs). Tests: [tests/js/qa_round06.test.mjs](tests/js/qa_round06.test.mjs).

**07:45 PST · Presets: previews no longer stall the stage, and the window docks beside the panels**
- **No stutter.** Previews render at 192×108 (512 px shadow), one step per frame inside an 8 ms budget; the scratch stage's clay shaders compile asynchronously (`compileAsync`). It's built and warmed during idle time after the App loads, not when the window opens. Closing the window stops the work. Cards show their drawn previews until each one is ready. Longest main-thread task while previews fill (1280×800, demo scene, heavily loaded Mac): about 4.1–4.3 s before, 0.9–2.0 s after.
- **Docking:** at 1280 and 1440 wide the window covered Properties. It now sits centred between the tool rail and Properties, and takes Properties' slot only when that space is too narrow. The `presets_panel` visual baselines were updated on purpose: no panel overlap at any size.
- Code: [web/presets/livethumbs.mjs](web/presets/livethumbs.mjs), [web/ui/presets.mjs](web/ui/presets.mjs), [tools/qa/visual_baseline.mjs](tools/qa/visual_baseline.mjs). Tests: [tests/js/presets_live.test.mjs](tests/js/presets_live.test.mjs).

**06:05 PST · Presets: every card previews your own stage, hover to try it on the shot, keyboard and search across tabs** *(Milestone 17 polish)*
- **Real previews.** Each card now shows the current stage in clay with that preset applied: camera moves and stunts loop, lighting and looks are stills. A hidden scratch copy of the scene renders them (the shot, its history and undo are never touched), visible cards first, a slice at a time; they're cached per scene, so reopening or undoing back shows them at once. The drawn preview stands in until each is ready. The window opens in about 50–215 ms.
- **Hover = preview on the shot.** Camera moves fly the real camera; lights, looks and stunts show over the shot ("Preview · Night street"); move off the card and the shot is back.
- **Keys and search.** ← → ↑ ↓ move between cards (focusing one previews it), Enter applies, Down from the search box enters the grid; search covers every tab, each hit tagged with its tab and the tabs show match counts. Fixed: ← → in the window also stepped the scene strip to another scene.
- **Toast:** "*Crane up* · Applied to shot 2 · Undo".
- Checked in a browser: every tab, apply + ⌘Z for camera, light, look, stunt and edit cards, the toast's Undo, saving / loading / applying / deleting your own presets, hover previews restoring the shot, 0 console errors (share/Milestone17_Presets/, with a recording). Visual guard: new `presets_panel` screen (baselines added); every other screen PASS.
- Code: [web/presets/livethumbs.mjs](web/presets/livethumbs.mjs), [web/ui/presets.mjs](web/ui/presets.mjs), [web/script/scenestrip.mjs](web/script/scenestrip.mjs), [tools/qa/visual_baseline.mjs](tools/qa/visual_baseline.mjs). Tests: [tests/js/presets_live.test.mjs](tests/js/presets_live.test.mjs).

**05:05 PST · QA round 05: the timeline editor fits the window, and the wheel scrolls like an NLE**
- **No scrolling:** at 1280×800 the audio tracks ended at y=1028. The editor now fills the CUT view exactly (checked at 1280×800, 1440×900, 1920×1080): the tracks keep their natural height when there's room and squeeze toward compact (V1 34 px, audio 22 px) when there isn't; the viewer takes the rest. **A ▾** folds A1–A4 to thin lanes so V1 gets its height back. The shortcuts line is one line (full text on hover).
- **Wheel:** scrolls the tracks up/down when they overflow (otherwise scrolls time); Ctrl/⌘+wheel or a trackpad pinch zooms time; Shift+wheel scrolls time. Before, the plain wheel zoomed and A1–A4 were out of reach.
- Evidence: share/QA/round_05/timeline_fit/ (before/after at three sizes, folded, short-window scroll). Code: [web/cut/cut.mjs](web/cut/cut.mjs). Tests: [tests/js/cut_fit.test.mjs](tests/js/cut_fit.test.mjs).

**02:06 PST · QA round 05: the phone viewfinder works upright, and the Ready dots are whole again**
- **Phone viewfinder, "Use it upright":** on a phone held upright the timecode, Grid, Frame and the Focus chip ran off the right edge and the lens row sat under the MOVE stick. The top bar and the lens / iris / focus row now wrap, the side rails start below the top bar, and "Use it upright" is a full-size tap target (checked at 390×844 and 375×667; landscape unchanged). Code: [web/vcam/viewfinder.html](web/vcam/viewfinder.html).
- **Ready dots:** the green dot on each step's corner was clipped by the rounded step button to a sliver that read as a stray backtick ("Cast`"). The button no longer clips; the step name still truncates with an ellipsis. Code: [web/ui/canvasui.mjs](web/ui/canvasui.mjs), [web/ui/theme.mjs](web/ui/theme.mjs). Tests: [tests/js/qa_round05.test.mjs](tests/js/qa_round05.test.mjs), [tests/js/viewfinder.test.mjs](tests/js/viewfinder.test.mjs).

**01:02 PDT · Try-it demo refreshed** ([live demo](https://claude.ai/artifact/GwtC3yFZtGCsTsiPGbvnAq)): the Director, Presets, the Timeline, Hollywood quality, take checks (the server's real chips) and the phone viewfinder, as six new What's new stops, five with their recordings; the Director's language model, Timeline renders and the vcam bridge say "available in the full install". Code: [tools/tryit/](tools/tryit/).

## 2026-10-31

**23:55 PDT · README and tutorial updated for the resubmission**
- README: a Highlights section (what only Soundstage does) and a "New since the contest" section with a picture for each: the Director and MCP, Presets, the Timeline, Hollywood quality, self-checking takes, live 3D physics and characters, stunts, the new sets, interop, the phone viewfinder. Stale claims fixed (Final HQ is now Hollywood, the Cut has transitions, seven steps, Blender 5.2.3).
- [docs/TUTORIAL.md](docs/TUTORIAL.md): step-by-step chapters for each new feature, new keys in the cheat sheet, current render times. New stills and GIFs in docs/media/ (about 9 MB, from the milestone evidence).

**22:51 PDT · QA round 04: Presets get every tab, ⌘Z works from the window, the top bar fits again**
- Presets now shows all tabs: Camera moves, Lighting, Looks, Action, Edit styles, Recipes and Mine (each tested in the App: apply, then ⌘Z reverts it, no console errors).
- ⌘Z / ⇧⌘Z right after clicking a card now undoes / redoes the preset (focus was on the card, so the stage never saw the key). No more 404 in the console when you have no saved presets yet.
- Below 1720 px, Presets and Director are icon-only, so the scene picker keeps its room and Done is no longer cut off at 1440. Visual baselines regenerated. Code: [web/ui/presets.mjs](web/ui/presets.mjs), [web/ui/canvasui.mjs](web/ui/canvasui.mjs).

**20:39 PDT · Presets window: one-click camera moves and lighting** *(Milestone 17)*
- **Presets** (top bar, or press `V`): a floating, searchable window. **Camera moves** (push in, pull out, orbit, crane up/down, dolly zoom, whip pan, handheld follow, drone reveal, tracking side, car mount) write editable camera keys and a rig onto the current shot; hovering a move plays it on the shot. **Lighting** (golden hour, blue hour, night street, noir hard key, neon, overcast, candle/firelight, studio three-point) sets the time of day, a lighting setup, the prompt words and the grade; on imported footage it readies Paint Studio's Whole frame.
- Every apply is **one undo step** (⌘Z or the toast's Undo) and reverts the look with the stage. The Director gets a `preset` tool ("make it a crane up at golden hour").
- Code: [web/ui/presets.mjs](web/ui/presets.mjs), [web/presets/](web/presets/), [soundstage/presets_agent.py](soundstage/presets_agent.py). Tests: [tests/js/presets.test.mjs](tests/js/presets.test.mjs), [tests/test_presets.py](tests/test_presets.py).

**20:34 PDT · The phone is the viewfinder** *(Milestone 20)*
- **Phone viewfinder** (Camera panel, *Phone camera* row): a QR code opens the stage on your phone, full screen and sideways, through the shot camera in the App's own Clay / Color look. The phone renders the scene itself (no video stream), so aiming has no lag. The desktop follows the phone's camera.
- Move the phone to aim (gyro, level lock, re-centre), MOVE / UP sticks, pinch or hold ± to zoom, **14–135 mm** primes, tap to focus, a focus ring with A/B marks and **Pull ⇄**, an **IRIS** dial (T1.4–T22) with a live depth-of-field preview, frame lines, grid and level.
- **● REC** counts in, records from the top of the shot in step with the action, and the take lands on the shot as camera keys (stabilized; Stabilize = gimbal) plus **lens keys** (focus, T-stop, roll). It plays back on both screens. Keep, Discard or Again from the phone.
- **LAN-only bridge** `tools/vcam_bridge.py`: https on the Mac's Wi-Fi with a pairing token and an allow-list (no /prompt, /queue, user files). Never public; the pod stays SSH-only. See [docs/vcam.md](docs/vcam.md).
- Code: [web/vcam/](web/vcam/), [soundstage/vcam.py](soundstage/vcam.py). Tests: [tests/js/viewfinder.test.mjs](tests/js/viewfinder.test.mjs), [tests/test_vcam_viewfinder.py](tests/test_vcam_viewfinder.py).

**20:32 PDT · A real editing timeline: transitions, fades, sound after generation, titles, subtitles, one-click render** *(Milestone 19)*
- **Edit like an NLE.** V2 (titles) over V1, a subtitles lane, and A1 Dialogue · A2 SFX · A3 Music · A4 Ambience. S splits, ⌘-drag (or `,` `.`) slips, trims ripple, ⌥-drag rolls, drags reorder with snapping, J/K/L, I/O, zoom, undo. Thumbnails on clips, waveforms on audio.
- **Transitions and fades.** Drag Dissolve, Dip black, Dip white or Wipe from the palette onto a cut (onto the head for a fade up, the tail for a fade out), or press T. They use the clips' handles, centred on the cut; when the handles are short the bar turns orange and says how much fitted. Click one to change its length or type. **Keys (R)**: rubber-band opacity on picture and volume on sound.
- **Sound after generation.** Type it and Generate: an SFX lands on A2, a music cue on A3, a line (`MARA: …`) on A1, at the playhead, made by the App's open-weights nodes (LTX-2.5 audio, Chatterbox). Import… for your own files. **Auto-duck** dips the score −12 dB under every line (editable keys). **Beats** finds the tempo; trims snap to it and **Cuts → beat** rolls every cut onto it. **Loudness**: −14 LUFS social, −23 EBU, −24 ATSC on render; **Measure** reads the mix (BS.1770).
- **Assemble scene** from the ScriptSync lining: the wide for action, an insert where it's lined, the speaker's single for their lines, cut on line ends, paced at speaking speed. Subtitles come from the typed dialogue (no speech recognition), with **Burn in**. **+ Title** puts a card on V2.
- **Render** MP4, ProRes 422 HQ or a 1080×1920 **9:16** social cut on the server (`POST /soundstage/cut/render`): xfade dissolves and wipes, fades, opacity keys, titles and subtitles drawn with Pillow, the mix (gain, fades, keys, duck, each Final's own sound) taken to the loudness target with a true-peak limiter.
- **NLE exports carry it:** the EDL as D / W001 events and BL dips, Premiere XML as Cross Dissolve / Dip to Color / Edge Wipe with level and opacity keyframes and Text titles, FCPXML transitions, volume and opacity keyframes and Basic Titles, OTIO Transitions and a V2; plus .srt and .vtt. The Python and browser writers still agree byte for byte.
- **For the director:** `CUT_ACTIONS` / `runCutAction` in `web/cut/cut.mjs` (split, trim, roll, slip, move, transition, keys, generate audio, duck, beats, assemble, subtitles, title, render).
- Evidence: a 6-shot car-chase cut rendered from real Finals (fade up, title, dissolve, wipe, fade out, sync sound + score at −14.0 LUFS / −1.7 dBTP) in 16:9 and 9:16, its contact sheet, and the four sounds generated in the App (a line, two effects, a score) in `share/Milestone19_Timeline/`.
- Code: [web/cut/fx.mjs](web/cut/fx.mjs), [web/cut/cut.mjs](web/cut/cut.mjs), [web/cut/gen.mjs](web/cut/gen.mjs), [web/cut/exporters.mjs](web/cut/exporters.mjs), [soundstage/cut/render.py](soundstage/cut/render.py), [soundstage/cut/export.py](soundstage/cut/export.py). Docs: [docs/cut.md](docs/cut.md). Tests: [tests/js/cut_m19.test.mjs](tests/js/cut_m19.test.mjs), [tests/test_cut_m19.py](tests/test_cut_m19.py).

**20:35 PDT · Hollywood-grade finals: quality presets saved per shot, and the full LTX controls** *(Milestone 18)*
- **The leak:** ⑤ Motion's Quality started on Draft and wasn't restored when a shot was reopened, so nearly every "final" rendered at Draft sampling (8 + 3). Shots now default to **Final** and keep their preset per shot.
- **Draft · Final · Hollywood.** Hollywood renders stage 1 at 704p, upscales x2 in latent space and refines at 2624×1408 (12 + 6 steps, same seed, H.264 CRF 12): sharper skin, rain and panel lines, and the J-turn car stays one coherent car. About 11–17 min a shot on the RTX 6000 Ada; each button shows its time.
- **Advanced (LTX)** beside Quality (a pop-over in the canvas layout): resolution, two-stage on/off, frame rate and frames, temporal x2, steps, stage-2 start sigma, manual sigmas, sampler, CFG, seed, layout IC-LoRA strength, an extra LoRA, decode tiles, and H.264 CRF or a **ProRes 422 HQ** master.
- Measured and rejected: bigger decode tiles (no visible gain, slower), the 1x skin ESRGAN (adds grain-pattern artifacts), temporal x2 without a refine (softer frames). CRF 18 vs 14 is a small loss (PSNR 49.8 vs 51.8 dB).
- Evidence: share/Milestone18_Hollywood/ (crops, clips, REPORT.txt). Not installed, for approval: Lightricks' LTX-2.5 Refine-Details IC-LoRA, the bf16 distilled and the dev transformers (MODELS.md).
- Code: [soundstage/ltx_settings.py](soundstage/ltx_settings.py), [soundstage/nodes_quality.py](soundstage/nodes_quality.py), [web/motion/ltxadvanced.mjs](web/motion/ltxadvanced.mjs), [web/motion/ltx_presets.json](web/motion/ltx_presets.json), [tools/app_build/ltx_advanced.py](tools/app_build/ltx_advanced.py). Tests: [tests/test_ltx_settings.py](tests/test_ltx_settings.py), [tests/js/ltxadvanced.test.mjs](tests/js/ltxadvanced.test.mjs).

**19:55 PDT · The Director: talk to the set, and drive it from Claude over MCP** *(Milestone 15)*
- **Director panel** (top bar, or press `/`): say or type what you want ("put Mara in the sports car at night, rain, camera on the hood, she's nervous"). It shows a short plan; **Apply** (Enter, or say "yes") runs each step through the App's own controls and every turn has **Undo this**. Talk-through mode explains the choice in film terms and offers the next step.
- **Tool layer:** 33 typed tools (cast and props, crate stacks, mounts, time and weather, lights, coverage, lens, animated camera moves, rigs, hood mounts, car stunts, drive-through crashes, physics and bake, performance notes, the grade, script scenes, frames, drafts and finals, approvals, the cut). Every call is validated against the live scene; renders always ask first unless you say "go".
- **Local and offline by default:** Qwen3.5 4B through ComfyUI's queue (about 2.5 s warm), an Ollama model on your computer, or the rules; while a render holds the GPU it plans from the rules instead of waiting. An API model is opt-in only (`SOUNDSTAGE_PARTNER_MODELS=1`).
- **Voice:** hold `` ` `` (or Space in the panel) to talk: the browser's speech recognition, or Whisper on the server (offline, open weights).
- **MCP server** (`tools/soundstage_mcp.py`, 36 tools): Claude Desktop / Code reads the set, proposes (dry run) and applies in the open App, undoable; GPU work needs `confirm_gpu`. See [docs/mcp.md](docs/mcp.md) and [docs/director.md](docs/director.md).

**19:50 PDT · Takes that check themselves, plus trust signals** *(Milestone 16)*
- **Self-checking takes.** Every draft and final is checked on the CPU right after it lands (about 7 s, no models): black frames, frozen or stuttering stretches, jumps and pops between frames, heavy smear, face drift (YuNet if a node pack already ships it, else OpenCV's Haar), and **cars that face the wrong way**: the stage knows every car's keyed path, so the lit lamp pair the take shows (red tail lights or white/amber headlights) is compared with the end that should face the camera. Chips sit under the Ladder's bar and on Dailies cards and take rows ("✓ clean", "⚠ freeze 2.1–2.6 s", "⚠ Sports car faces the wrong way"); a click jumps the Ladder there. **Re-roll** (new seed) asks first and says what it costs in GPU time.
- On the pod's 212 existing drafts and finals: the old backwards red-car take `final_00028_` (and its draft and sound version) is flagged; the new `final_sound_00047_` is clean. Cars too small, half hidden, seen through a windscreen or in profile get no verdict rather than a guess.
- **Follows your blocking %.** We own the ground truth: the clay camera and every actor's mark. The camera move of the take (OpenCV feature tracks, actors masked, RANSAC) is compared with the stage camera step by step on every take; **Measure** runs SAM 3.1 (the Layer Pack's checkpoint, nothing downloaded) through the queue and scores each actor's IoU against its projected stage volume over time. One score per take with a hover breakdown; a camera-only score is never shown green, and "can't tell" is never a pass.
- **Ready to run / needs X** on every step button: the chosen models' node classes and files (the router registry plus the graph's own loaders, reusing the model guard), with a click-open list and a link to MODELS.md.
- **"$0 · about 2 min on your GPU"** under ④ Generate and ⑤ Draft / Final, from measured render times (ComfyUI's history, kept in `user/soundstage/timings.json`); defaults are the 48 GB card's numbers (draft ~95 s, final ~6 min for 121 frames).
- **The recipe travels in the MP4.** Every App render now carries a `soundstage` metadata tag (stage scene, shot, look, seeds, quality); older takes are read from ComfyUI's own prompt tag. Drop a Soundstage MP4 on the stage and it offers to restore its set and shot.
- Code: [soundstage/takecheck/](soundstage/takecheck/), [soundstage/nodes_takecheck.py](soundstage/nodes_takecheck.py), [web/takecheck/](web/takecheck/). Tests: [tests/test_takecheck.py](tests/test_takecheck.py) (each detector on synthetic ffmpeg clips, a synthetic street with a car shown both ways, the blocking score on box/matte pairs, readiness, timing, the MP4 round trip), [tests/js/takecheck.test.mjs](tests/js/takecheck.test.mjs).

**19:24 PDT · Try-it demo updated with everything since the contest version**
- The [live demo](https://claude.ai/artifact/GwtC3yFZtGCsTsiPGbvnAq) now runs the current App: the canvas layout and first-run card, seated cast behind see-through car glass, lit lamps, horses and riders, live drags (climb, mount, pick up, push) with a CPU fallback for the GPU solver, the stunt picker, the seven new sets, ScriptSync with real dailies, Ripple and Pose follow, and the DCC kit card.
- 20 scenes in a scene picker. New ones: Dry Creek (the sample script with its desert, main street and beach scenes and their real renders), the reverse J-turn, a live-physics playground, and underwater, fire, airplane cabin, train carriage, platform, runway and above the clouds, each set up by the App from a slugline. A What's new tour opens each feature on its scene and plays the real renders and recordings.
- The Car Chase demo's backwards chase-cam take is replaced by the fixed one.
- Server-only features (Director chat, Video to 3D, Ripple and Pose renders, Layer Pack) say they're available in the full install, never an error.
- Rebuilding after a milestone is one command plus one Artifact publish: `python3 tools/tryit/build_tryit.py`. See [tools/tryit/README.md](tools/tryit/README.md). The click-through test is `tools/tryit/test_tryit.mjs`.

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
