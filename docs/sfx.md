# Practical effects rigs

Soundstage rigs special effects the way a film crew does: you place an effect on the set, give it a **cue**, and when
the cue comes the set reacts. Crates fly, a car rocks or rolls by its weight, a lamp post goes down, a stunt performer
is knocked off their feet, props catch fire, glass shatters, a squib bursts on a jacket. Everything is baked into
ordinary keys, so every capture of a frame is the same, and everything can be taken back.

These are on-screen effects for fiction. Soundstage describes what the audience sees; it has no recipes, charges, real
devices or weapon details, and the blood is stage blood at a film level (a TV-14 to R-rated look).

## The rigs

Open **Physics** on any selected object, then **SFX · practical effects → Add rig**.

| Rig | What it does on screen | What it does to the set |
|---|---|---|
| **💥 Explosion (fireball)** | A rolling orange fireball (self-lit in the clay), a ring of ground dust thrown flat by the shockwave, charred debris and embers, then a column of black smoke for about 4 s; a bright orange flash lights the set; the shot camera shakes when the shockwave reaches it. | Every body in **Reach** gets a radial push with falloff, acting at the side facing the charge (the near side lifts). Heavier things move less. A keyed or parked car, a person, a resting crate or a lamp post is let go to the physics if the push is enough. Breakable crates and boxes crack or burst. Flammable props inside half its reach catch fire. A scorch mark on the ground. |
| **🔥 Fire / flames** | Flames and smoke, flickering firelight. | Wood, cardboard, fabric and (slowly) plastic props next to it catch, and fire spreads from one to the next. Each burning thing gets its own flames, smoke, light and a scorch mark. |
| **✨ Sparks shower** | A fall of hot sparks (a gerb or grinder gag) for its duration, lighting the set orange. | — |
| **• Bullet-hit squib** | By **Surface**: dust and chips off a wall, a spurt of dirt from the ground, glass shards, sparks off a car's bodywork, a spout of water. Squibs can fire many times (each press of Fire adds a hit). | A ground squib leaves a small mark. |
| **☁ Smoke bomb** | A plume of coloured or grey smoke for 7 s. | — |
| **▦ Breakaway glass** | A candy-glass pane, a real prop in the shot (it shows in Clay and Color) until its cue, then a spray of glittering shards. On a **contact** cue it breaks when something goes through it. | — |
| **🧨 Road flare** | A red glow, sparks and a pink smoke trail for 12 s. | Can light what it lies against. |
| **🩸 Body squib / blood pack** | Rigged on a person's wardrobe at the chest, stomach, a shoulder, the back, an arm or a thigh: a puff of fabric and a burst of stage blood. The stain spreads and stays, and a little blood runs down. | The hit reaction (below). |
| **🗡 Stunt-knife stab gag** | A retractable prop knife with a blood tube: a slash line on the wardrobe and a thin line of stage blood. | The reaction: doubled over, both hands to it. |

The rig markers (the mortar pot, the fire bar, the squib...) show while you block the scene and are never in a capture,
the depth pass or the ID matte. Only the breakaway pane is in the shot, because it is a real prop until it breaks.

## Cues

| Cue | When it fires |
|---|---|
| **At a time** | At a second on the shot. |
| **On contact** | At the first hard hit (over 1.5 m/s) on the object it **watches**, or, watching nothing, at the first hit within its reach or the first moment anything solid comes within reach (a car through a pane of breakaway glass). |
| **After another cue** | A set delay after another rig fires: the squibs that walk across the ground, then the body squib; the explosion, then the wreck burning. A loop of chains fires each rig at most once; a chain after a disarmed rig never fires. |
| **Manual (Fire / K)** | When you press **💥 Fire** or **K** (**Shift+K** with a car selected: plain K keys its parts), at the playhead, during playback too. The press is written down as the rig's key (one Undo step), so it fires there in every take. An explosion keeps only your newest press; squibs and sparks add each one. |

**Drive mode:** **K** fires the cue rig (the selected rig, else the first armed manual one) during **● REC**; when you
**Keep** the take, the moment becomes its key. Outside a take, K in Drive mode only says what it would do.

## The hit reaction

A body squib or knife gag drives the person's animation the way a stunt performer plays the hit, scaled by **Power**:

| Where | Reaction |
|---|---|
| Chest | Snaps back in 2-3 frames, both hands to the chest, staggers back; falls backwards (power 0.9 and up). |
| Stomach | Doubles over, both hands to it; drops forward. |
| Back | Thrown forward, arching; falls face down. |
| Shoulder | Spins with the hit, the other hand to the shoulder; goes down. |
| Arm | Flinches, the other hand to it; stays up. |
| Thigh | The leg buckles; drops to one knee. |

**Fall** overrides it (by the hit, always, never). Several hits add up; the first fall wins. A person a blast knocks down
is the physics' (the bake), not a reaction.

## Reversible: Reset to before, tweak and re-run, A/B

- **Scrub back** before a cue and everything is the untouched original: the keys before the cue are the authored ones,
  and the fireball, the scorch, the wounds and the reaction are worked out from the frame, never left behind.
- **Reset to before** (on the rig, or on any object an effect touched) disarms the rig (its settings are kept) and puts
  every object it touched back exactly, byte for byte: no fragments, scorch, wounds or blood. If nothing else in the
  scene needs a bake, the scene goes back to how it was before the first SFX bake; otherwise it is re-baked from the
  authored keys without that rig. It is one Undo step.
- **Tweak and re-run:** change the power, the reach, the position or the cue and the stage re-bakes by itself from the
  authored scene (never on top of the damaged result). The result is the same as baking the new settings on a fresh scene.
- **A / B** swaps between the previous run and the new one, to compare (it is not an Undo step; an edit ends the pair).

## Presets

In **Presets → Action**:

- **Car explosion**: a mortar under the car's sill (power 2.2): fireball, shockwave, the car thrown over (it rolls or
  lands on its roof), then the wreck burns (a fire chained 0.15 s after). A moving car is parked where it is at the cue.
  With no car on set, one is added.
- **Building blast**: charges at the foot of a breakaway wall (power 3.6): the blocks blow out, a rolling dust cloud,
  three crates in front thrown. With no wall, a stone breakaway wall is added 6 m in front of the camera.
- **Sparks shower**: a gerb 3.2 m up pours sparks for 3 s.
- **Squib hit**: three ground squibs walk in towards the performer 0.12 s apart, then the body squib on the chest.

## How strong is it?

The blast is a film-scale gag, tuned so the defaults read right on screen (measured in the bake, see
[tests/js/sfx.test.mjs](../tests/js/sfx.test.mjs)): power 1 beside a parked car rocks it hard and it lands on its
wheels; 1.5-2 rolls or flips it; a person 4 m away goes down from power 1; a lamp post 2.5 m away falls from power 1.5;
a 25 kg crate 2 m away is thrown at about 4 m/s. Inside 2 m (the core) it is at full strength; beyond, it falls off
with the square of the distance, and is zero at its reach.

## In the prompt

The bake writes `scene.physics.sfx` (the fires, what caught fire, what each blast did, the wounds), and the motion
prompt gets one beat per cue ([soundstage/look/sfx.py](../soundstage/look/sfx.py)):

> At 1.5 s a huge fireball erupts beside the red car: a rolling orange fireball and a shockwave that throws debris
> outward; the red car is thrown up and lands on its roof, the man is knocked off his feet; then a column of thick black
> smoke rises, and a bright orange flash lights the set, the camera shaking with the blast.

> From 1.0 s three bullet hits stitch across the ground, kicking up spurts of dirt. At 1.5 s a squib bursts on the man's
> chest with a puff of torn shirt fabric and a spray of stage blood; he jolts back, clutches his chest and falls
> backwards to the ground. A dark red stage-blood stain spreads across the man's shirt at the chest and stays for the
> rest of the shot.

The rigs themselves are crew equipment and are never described as things in the shot.

## Code

[web/stage/sfx.mjs](../web/stage/sfx.mjs) (pure: kinds, cues, the blast's falloff, fire spread, emitters, light, shake,
scorch, wounds, reactions), [web/stage/sfxstage.mjs](../web/stage/sfxstage.mjs) (the stage: rigs, the bake passes,
Fire, Reset to before, A/B, the per-frame effects), [web/stage/physics.mjs](../web/stage/physics.mjs) `simulate(…, { blasts })`,
[web/stage/particles.mjs](../web/stage/particles.mjs) (fireball, flame, smoke, stage-blood presets),
[web/stage/sfxpanel.mjs](../web/stage/sfxpanel.mjs), [web/presets/sfxpresets.mjs](../web/presets/sfxpresets.mjs).
