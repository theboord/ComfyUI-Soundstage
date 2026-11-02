# World collisions: everything collides in the bake

**Simulate & bake** treats the whole set as a real place. A police car keyed through a parked car crashes into it
instead of passing through; a car that clips a street lamp knocks it down; a car into a solid wall stops and crumples,
into a weak one it breaks a hole and carries on; a person in the way is knocked over. Before the first real contact
every keyed actor is exactly on its keys, and after it the physics decides by real masses, speeds and strengths.

Code: [web/stage/world.mjs](../web/stage/world.mjs) (the world model, pure JS), the solver hooks in
[web/stage/physics.mjs](../web/stage/physics.mjs) (`takeover`, `anchor`, `aniso`, `crush` specs), the stage wiring in
[web/stage/stage.mjs](../web/stage/stage.mjs) (`simulatePhysics`, `consequenceCheck`, `setKeepKeyed`,
`setWorldCollisions`, `rerouteAround`) and the Director tools `ram`, `check`, `reroute`, `keep_keyed`
([soundstage/agent/director.py](../soundstage/agent/director.py), [web/agent/director.mjs](../web/agent/director.mjs)).
Tests: [tests/js/world.test.mjs](../tests/js/world.test.mjs), [tests/js/world_stage.test.mjs](../tests/js/world_stage.test.mjs),
[tests/js/world_edges.test.mjs](../tests/js/world_edges.test.mjs) (chain reactions, many cars, people, overlaps, re-bakes,
degenerate input), [tests/test_world_director.py](../tests/test_world_director.py), [tests/test_world_edges.py](../tests/test_world_edges.py).

## What each thing is

| On the stage | In the bake | Numbers |
|---|---|---|
| Car, police car, sports car, hatchback, truck, motorcycle | Keyed until its first real hit, then a rigid body: chassis with a raked nose, cabin, four wheels. Tyres grip across (0.85 g) and brake along (0.55 g; `physics.afterContact: "coast"` rolls at 0.02 g). Centre of mass at 0.38 of its height, real roll / pitch / yaw inertia. | 1.2 t (hatchback) to 2.7 t (truck); police car 1.9 t. Crush stiffness about 1e6 N/m. |
| Man, woman, child | Keyed until hit, then a body that topples (ragdoll-lite: one rigid body, no limbs). | 80 / 65 / 30 kg |
| Street lamp (and the set's lamp posts) | Bolted on a breakaway base: stands until a hit's force passes its strength, then it is a loose pole. | 140 kg, 40 kN, 3 kJ |
| Bench, sign, hydrant, bollard, tree | Anchored the same way (a tree only by its trunk). | bench 15 kN · hydrant 150 kN · bollard 600 kN · tree 1.2 MN |
| Wall (concrete, stone; the default) | Solid: a car stops against it. | |
| Wall of wood, cardboard, plastic or glass (or `physics.weak: true`) | Blocks (0.6 × 0.5 m), each held up by the one under it: a car breaks through above about 1.7 m/s and stops below. | 60 kN, 1.5 kJ a block |
| A prop nobody set to Dynamic or Static (a crate) | Rests exactly where it is until something touches it; what stands on it comes down with it. | |
| A prop set to Static | Fixed: a car stops at it. | |

## The rules the bake follows

- **Who is let go.** At a contact, the closing speed `v` decides. A keyed car is taken over when the hit would change its own
  speed by more than 1 m/s: `v` against anything that won't move, `v · m_other / (m + m_other)` against something that will.
  Small hits add up: a car through a wall of 30 kg blocks, or through two people, is taken over once their sum passes 1 m/s,
  and the momentum it gave away while keyed is taken off it then. A 1.5 t car through 25 kg crates keeps its keys.
- **When an anchor gives.** When the peak contact force `v · sqrt(k · m_hitter)` (k: the two crush stiffnesses in series)
  passes its strength and the hitter brings more momentum than 10 × the anchor's mass. The hitter then pays its break energy
  (`v' = sqrt(v² − 2E/m)`). A breakaway lamp costs a car at 43 km/h about 1 m/s; a thrown crate doesn't shear it.
- **Nothing passes through.** Anything keyed still pressing more than 2 cm into something that won't move is taken over too.
- **Hits pass along.** A car shunted into a parked car it touches (a queue bumper to bumper) passes the hit on: the one in
  front is judged by the same rule at the speed the hit arrives with, so a queue moves as it would with gaps.
- **Placed inside each other.** Things that start more than 2 cm inside each other or the set (a car parked into a wall,
  someone standing in a bumper) stay exactly where they were put; once hit they are eased apart slowly, with no speed from
  the overlap, and still stop each other going further in. The consequence check reports the overlap after the bake.
- **Crush.** A car absorbs `E = ½ μ v²` (μ: the pair's reduced mass), shared with the other side by stiffness; its crush depth
  is `sqrt(2 E_car / k)`. That is about 0.46 m for a 1.45 t car into a rigid wall at 43 km/h. The crush is stored as a dent
  on the car (`physics.dents`), which the clay shows.
- **Flips.** Nothing is scripted: a car rolls when the physics rolls it. Sliding sideways into a kerb, it trips above the
  critical sliding velocity `v_c = sqrt(2 g (d − h) I_edge / (m h²))` (about 9 m/s for a sedan into a 15 cm kerb) and not
  below. On flat ground a T-bone shoves a car sideways but its tyres can't roll it (0.85 g of grip is under its stability
  factor, about 1.4), as with real cars.
- **Kerbs** (anything in the set under 30 cm) are climbed by a keyed car's wheels; once the physics has the car, a kerb is
  something it can trip on.

## Reversible and fluid

- The bake is deterministic: the same scene bakes bit-identical keys, so scrubbing back shows exactly what was there.
- A world body the physics took over gets its keys from the bake (its authored keys up to the hit, the physics after it);
  the ones before are kept (`physics.source`). **One Undo** puts the whole scene back as it was before the bake.
  **Clear simulation** does the same for the physics only.
- **Editing re-bakes by itself.** Edit a key or drag anything in a baked scene and, once you stop for 0.45 s, the scene is
  re-baked. An edit on a baked object goes into its authored keys (a dragged crate moves its rest position; a key edited
  on a car's path becomes one of its keys), so the re-bake starts from what you meant. The edit and its re-bake are one
  Undo step. Scene switch: `physics.autoBake: false`.
- Each takeover is marked: the bake message says *"Police car: physics took over at f 42 (1.8 s), hit the red car at
  44 km/h"*, the Physics panel says it for the selected actor, and `scene.physics.takeovers` has every one.

## Controls

- **Physics panel → World → Everything collides** (on by default; off: only Dynamic props collide, the behaviour before).
- **Physics panel → World → Keep keyed** (a car or a person): it stays on its keys whatever it hits. The consequence check
  then reports what it passes through.

## The consequence check (Director)

*"check for collisions"*, or before any render: everything solid is swept over the shot on the same convex shapes the bake
collides (fast movers between frames too) and anything passing through anything is reported in plain words, with
one-click fixes:

> The police car passes through the red car at 2.1 s: crash them, or reroute?
> **Crash them** · **Reroute**

Before a render, a scene that hasn't been baked is baked first (the physics resolves what it can); whatever still passes
through something (a Keep keyed actor) stops the render and asks. *"render the draft anyway"* renders it as it is, and
with **Everything collides** off the check doesn't stop a render (pass-throughs are what you asked for).

## Director

- *"the police car rams the red car into the boxes"*: the `ram` tool plans the speed by momentum, so the red car is
  shoved to the boxes. Hit at rest, it leaves at `(1 + e) m₁ v / (m₁ + m₂)` (e = 0.1: car crashes are nearly plastic)
  and slides `v² / (2 μ g)` under its tyres; the police car's speed is the one that gets it there with 25 % to spare.
  Then the bake plays it out (who spins, who stops) and the Director says where the physics took over.
- *"crash the police car into Mara"*, *"the red car hits the street lamp"*: the same tool, no target.
- *"reroute the police car around the red car"*: a swerve key where they would meet, clear of it.
- *"keep the police car keyed"* / *"let physics take over the red car"*.

## Known limits

- After the hit a car is one rigid body: the crush is a dent and a logged depth; the body doesn't fold, doors don't
  spring, wheels don't come off. Its wheels don't spin or steer after the hit (the tyres are modelled as grip, not as
  rolling wheels).
- People are one rigid body (ragdoll-lite). A person the physics took over still plays the walk cycle while sliding.
- A rider (a driver in a car that rolls) turns with the car's heading but doesn't roll with it.
- Stopping against a wall takes one substep (the car is rigid); a real crush takes about 0.1 s (2 frames).
- Weak walls are block grids; plasterboard tearing, glass shattering and bricks are not modelled separately.
- Only the set's lamp posts (street, plaza) are knock-down set pieces; facades, kerbs and planters are fixed.
