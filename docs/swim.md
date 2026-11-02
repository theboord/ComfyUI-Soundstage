# Swimming and water

People in water swim with the physics that sets how a real body moves there. Divers on the **Underwater reef** flutter-kick, frog-kick or hover. Swimmers in a **Water tank** or **Open water** swim freestyle or breaststroke at the surface, or tread water. The water around them moves too: waves, caustics, light shafts, a current, bubbles, kelp, sea fans, drifting particles and stirred sand.

| File | What it does |
|---|---|
| [web/stage/swim.mjs](../web/stage/swim.mjs) | Styles, cadence, surge, breathing, bubbles, the pose on the figure, the dive kit, fin flex, fin wash, the wake |
| [web/stage/water.mjs](../web/stage/water.mjs) | The wave field, caustics (CPU and GLSL), Snell's window, the refracted sun, the current and its surge |
| [web/stage/sets/underwater.mjs](../web/stage/sets/underwater.mjs) | The reef: surface, shafts, kelp, swaying fans and grass, marine snow, bubble drawing |
| [soundstage/look/swim.py](../soundstage/look/swim.py) | The kit, the stroke and the bubbles in both prompts |
| `tests/js/swim.test.mjs`, `tests/test_swim_words.py` | 21 JS tests and 4 Python tests |

## When someone swims

The stage decides this per frame, from the actor's keys.

- **On the reef**, a person whose keyed origin is more than 0.35 m above the seabed swims. If their hips are within 0.45 m of the surface (10 m), they swim at the surface.
- **In a tank or open water**, a person over the water and at or below its level swims at the surface. With `swim` set to an underwater style and keyed below the surface, they dive.
- `swim: "off"` keeps the old behaviour: walking on the reef, floating upright in a tank.

Actor fields, all optional:

| Field | Values | Default |
|---|---|---|
| `swim` | `flutter`, `frog`, `stroke` (arms forward), `freestyle`, `breaststroke`, `off` | picked from the place and the speed |
| `gear` | `scuba`, `freedive`, `none` | `scuba` under water, `none` at the surface |
| `appearance.fins_color` | a colour | yellow |

With no `swim` set, the style follows the speed. Under water a diver hovers below 0.07-0.2 m/s and flutter-kicks above it. At the surface a swimmer treads water when still, swims breaststroke up to about 0.75 m/s, and freestyle above that. The styles cross-fade, so a swimmer slowing down eases from one into the next.

## The physics

**Cadence.** A fin kick works like a fish's tail. The Strouhal number, St = f·A / v, relates the kick rate f to the fin tip's peak-to-peak sweep A and the speed v. Fish cruise at St 0.2-0.4. A finned human is less efficient, so Soundstage uses 0.6. At a 0.5 m/s cruise that gives 0.7 Hz with a 0.43 m sweep. The cadence stays between 0.5 and 1 Hz: past 1 Hz the kicks get bigger instead of faster.

| Style | Cadence | Notes |
|---|---|---|
| Frog kick | 0.3-0.55 Hz | One power phase, then a coast |
| Freestyle | 30-55 arm cycles a minute | A six-beat kick |
| Breaststroke | 0.5-0.95 Hz | Pull, kick, glide |

**Surge and glide.** For each style and speed, a short periodic simulation solves

m_eff · dv/dt = T(phase) − ½ ρ Cd·A(phase) · v²

- **The thrust T comes in pulses.** Flutter has a downbeat per leg, the frog kick one kick, breaststroke a pull and a kick.
- **The drag rises while the limbs recover.** Breaststroke's heels-up recovery is the brake.
- **The mass includes the water carried along.** A diver plus kit is about 105 kg, with 15 % added mass.

The thrust is scaled so the cycle's mean speed is the keyed speed. The body moves along its path by the result's zero-mean displacement: the speed rises on each kick and decays through the glide.

| Style, speed | Speed through the cycle |
|---|---|
| Frog kick, 0.4 m/s | 0.29 to 0.52 m/s |
| Breaststroke, 0.8 m/s | 0.52 to 1.08 m/s |
| Flutter, 0.5 m/s | within 2 % |

**Trim, buoyancy and breath.**

- **Trim.** A diver lies level with the head a touch up. They pitch along their climb or descent and bank into turns.
- **Breath.** Each diver breathes on a cycle of 3-5 s, seeded per diver.
- **Buoyancy.** An inhale adds about 2.5 L of lung volume, roughly 25 N of lift. The diver rises a few centimetres and the chest tips up about 0.9 s later, because a heavy body in water lags its lungs.

**Bubbles.** Each exhale leaves the regulator's exhaust tee as a burst that carries the breath's real volume, about 1-2 litres of gas. Most of it goes out in the first moments as a column of about twenty big, wobbling cap bubbles (3-6.5 cm), with a fizz of millimetre bubbles around them and trailing after.

- **Rise speed by size.** Bubbles of about 1 mm rise at ~0.1 m/s. Wobbling bubbles of 2-15 mm rise at 0.24 m/s. Caps over 15 mm follow Davies & Taylor, 0.711·√(g·d).
- **Growth.** Bubbles grow as they rise (Boyle's law, d ∝ P^-1/3): ×1.26 from 10 m to the surface.
- **Motion.** They wobble, drift with the current and vanish at the surface.
- **Freedivers** (`gear: "freedive"`) hold their breath and make no bubbles.

**The strokes on the figure.**

- **Flutter.** The kick comes from the hips. The knee folds at the top of the upbeat and snaps straight through the downbeat. The feet stay pointed. A small counter-wave runs up the spine, and the body heaves at twice the kick rate. The hands are folded under the chin.
- **Frog kick.** Knees drawn up with the fins high, a sweep out and back together, then a coast.
- **Freestyle.** The body rolls about 37° toward the pulling arm, with a high-elbow catch. The arm recovers high and wide over the water, and the head turns with the roll to breathe on the right.
- **Breaststroke.** The arms sweep out and in while the head and shoulders rise to breathe. Then the heels come up, the legs whip round together, and the swimmer glides.
- **Treading water.** Eggbeater legs and sculling hands, with the head out of the water.

**Fin flex.** The blade is a cantilever loaded by the water. Its tip bends against its own velocity through the water, along the blade's normal, with a load ∝ v|v|. The bend lags by about a third of a frame, so the blade snaps through at each reversal. That gives about 20-25° at a cruise kick and at most 0.6 rad. The velocity is measured on the posed figure half a frame either side of the current one.

## The kit (`gear: "scuba"`)

- **Mask.** Frame, lens, nose pocket and strap.
- **Regulator.** The second stage's mouthpiece passes through the lips at mouth height. The test checks it crosses the face surface. The body of the regulator sits just in front of the chin, with a purge button and an exhaust tee.
- **Hose.** Rebuilt every frame: from the second stage, looping a little toward the seabed, over the right shoulder to the first stage on the tank valve.
- **Tank and jacket.** An aluminium 80 tank, a buoyancy jacket with straps and a back bladder, a yellow octopus clipped on the right chest, and a weight belt.
- **Fins.** A foot pocket over each shoe, and a tapered blade that bends as described above.
- **Secondary motion.** The jacket's strap tails stream back and flutter, faster with speed and current. Long hair is buoyant: it lifts off the back, undulates and drifts.

The kit is part of the actor, so the ID matte covers it. Its materials get the caustics in Color.

## The water

**Waves.** Eight deep-water components, from 0.6 to 14 m long, with ω² = g·k. The same field is used everywhere:

- it displaces the reef's surface mesh;
- it shimmers Snell's window, the 48.6° cone of sky seen from below, with the dim mirror of total internal reflection outside it;
- it focuses the caustics;
- it flickers the light shafts.

**Caustics (Color only).** A ray that reaches a point D metres down crossed the surface where the slope shifted it by D·(1 − 1/n)·∇h. The brightness is 1/|det J|, with J = I + D′·Hess(h): where neighbouring rays cross, the light piles up into the moving network. The contrast fades as exp(−d/16 m). The mean stays about 1, which the test checks: the light is moved around, not added. The same code runs on the CPU (tests) and in the patched shaders: seabed, rocks, coral, kelp, fans, the diver and the kit. The stage resets the strength to 0 before every render, so only the reef's Color pass turns it on.

**Light shafts.** They fall along the refracted sun (Snell's law at the surface), recomputed from the stage sun every frame. Each breathes with the focus of the waves over its root.

**Current and surge.** A slow mean drift of 0.05 m/s plus the orbital motion of a long ocean swell (110 m, 8.4 s period, 0.35 m high). That motion reaches the bottom as a to-and-fro of about 0.17 m/s and 0.2 m each way at 8 m depth. It drives:

- **Kelp.** It leans with the drift and is carried by the surge, the motion travelling up the blade, plus a fast flutter of the ribbon edges.
- **Sea fans, sea grass and anemone tufts.** They are now their own vertex-coloured mesh, moved on the CPU so the motion shows in Clay and Depth. They bend about their holdfasts.
- **Marine snow.** It drifts and barely sinks.
- **Bubbles, straps and stirred sand.**

Hard coral (staghorn, brain, table) stays rigid, as it is. The staghorn colonies now grow up toward the light with irregular forks, corallite knobs and pale growing tips.

**Stirred sand.** A diver's fins within 0.9 m of the seabed, on a downstroke, throw a jet onto the sand. The strength is ∝ (1 − h/0.9)² × the tip speed. The emitters go into the shared particle system (Milestone 28, preset `seabed_silt`): fine sand that hangs for 5-9 s, drifts with the current, settles at a few cm/s, and never sinks through the seabed. Under water the particle "wind" is the current and the floor is the seabed. The fin tips are measured on the posed figure over the whole shot and cached per plan.

**Wakes.** Surface swimmers leave foam:

- a bow wave at the head;
- the white water of the kick on the line behind the feet;
- a splash at each freestyle hand entry for about 0.6 s;
- the two arms of the Kelvin wake, 19.47°, spreading behind.

## Prompts

[soundstage/look/swim.py](../soundstage/look/swim.py) adds words to both prompts for divers on the reef:

- **Still prompt:** "the man wearing a scuba tank and a black buoyancy jacket, a dive mask and long yellow fins, the regulator's mouthpiece held in his mouth with its black hose looping over his right shoulder to the tank valve, lying level in the water".
- **Still negative:** "regulator hanging below the chin, regulator out of the mouth, mouthpiece dangling, no fins, walking on the seabed".
- **Motion prompt:** the kick ("slow, steady flutter kicks from the hips …", "strong, quick" past 0.8 m/s), "the regulator held in his mouth throughout", the bursts of bubbles every few seconds, and the drift of straps and hose.

Surface swimmers get their stroke in words. There are no numbers, because LTX reads none.

## Presets

**Action › Diver swim** (`diver_swim`, `apply: {swim: "flutter", speed: 0.5}`) works on the selected person, or the first one:

- they get a black wetsuit and hood, and scuba kit;
- they swim 0.5 m/s along their heading for the shot, 0.5 m over the seabed (their hips about 1.45 m over it), with a gentle rise and settle mid-shot;
- the set changes to the Underwater reef unless it is already a water set.

The Director finds it with "scuba diver", "flutter kick" or "swim underwater". The engine also takes `swim: "frog" | "freestyle" | "breaststroke"`; the surface styles move the set to Open water.

## Tests

```sh
node --test tests/js/swim.test.mjs
python -m pytest tests/test_swim_words.py
```
