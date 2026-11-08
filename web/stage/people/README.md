# Lifelike people (Microsoft Rocketbox avatars)

Men and women on the 3D stage can show as lifelike people instead of the clay figure. The clay figure is still there underneath and runs everything (walk, keys, gaze, mounts, mocap, Drive); only its meshes are hidden while the lifelike body shows. Children and everything else stay clay for now.

## Getting the files (they are not in the repo)

The avatars and clips come from [Microsoft Rocketbox](https://github.com/microsoft/Microsoft-Rocketbox), MIT licence, Copyright (c) 2020 Microsoft, pinned at commit `0943055db6ec570bcef9f2c8b41c9e5467c808f9`. Only fetch from that commit or a later one: before 2020-11-17 the library had a non-commercial licence.

They are kept out of git (about 27 MB). For now a maintainer puts them in `web/stage/people/rocketbox/` by hand; a one-click download from the pinned commit comes later. The folder holds:

| File | From the Rocketbox repo |
|---|---|
| `Male_Adult_01.fbx`, `Female_Adult_01.fbx` | `Assets/Avatars/Adults/<name>/Export/<name>.fbx` |
| `tex/m002_*.png`, `tex/f001_*.png` (body / head colour, normal, specular, and the opacity map; the specular maps are not used and never downloaded) | the avatars' `Textures/*.tga`, shrunk to 1024 px PNG with macOS `sips`; the opacity PNG keeps its alpha |
| `anim/m_idle_neutral_01.max.fbx`, `m_walk_…`, `m_run_…`, `m_gestic_talk_…`, `f_idle_…`, `f_walk_…`, `f_run_…` | `Assets/Animations/all_animations_max_motextr_static/` and `_xy/` |
| `LICENSE.md` | the MIT licence, copied next to the files |

Without the folder every person silently stays clay (one line in the browser console says so).

## How it works

- `avatars.mjs` loads each avatar once (FBXLoader; every `.tga` the FBX names is loaded as `tex/<same name>.png`, because three's FBXLoader has no TGA reader here), keeps only the most detailed mesh, swaps its Phong materials for the Standard material the rest of the set uses, and clones it per person.
- The body is scaled by its measured standing height (top of the head in the idle pose), so it stands as tall as the person is set to (the woman's hips sit higher than the clay's, so hip height can't be used).
- The body plays its own Rocketbox clip: idle when still, walk, run, crossfaded by ground speed over about half a second. Walk and run share ONE gait phase that advances with the distance travelled over the stride of the clips as mixed, so a walk-run blend stays in step and the feet don't skate; idle runs on the shot's frame clock. The pose depends only on the frame number, so renders are frame-exact.
- Only the steady ground travel of each clip (on the root bone `Bip01`) is removed: the straight line from its first key to its last. The sway and surge within a stride and the idle's weight shift stay, so a foot the clip plants stays planted.
- A capture (sprite sheet) waits for bodies still loading (up to 60 s, `stage.avatarWaitMs`; past that it goes ahead, says in the status line who stayed clay, and `stage.lastCaptureNote` keeps the message), and a body that finishes loading during a capture goes on after it, so a capture is never part clay, part lifelike. A failed load is not remembered: the next rebuild of the stage tries again.
- A rebuild of the stage (changing the set, an appearance, adding someone) keeps each person's lifelike body when their avatar model is unchanged, and many people attaching at once cost one re-pose, not one each.
- Depth, ID, Clay and Wire passes and the dust matte all draw the posed body. The hair and lash cards keep their cut-out in every pass (`cutout.mjs`: the card swaps in a version of the pass material with the card's alpha and alpha test, which the pass's override material can't replace), so they never show as solid quads. The underwater set's own Depth material is the same skinning shader. The Pose pass reads the lifelike body's real bones while it shows.
- The physics lift (an unbaked dynamic or static object raised to its start height) moves the lifelike body with the clay.

## When the clay shows instead

M1 can't yet make the lifelike body follow everything the clay can do. A person stays clay for the whole shot (never a swap mid-shot) when they ride or sit on something, are carried, carry something or hold a prop, play a video mocap take, have Pose keys or gaze keys, swim anywhere in the shot (every Swim mode, `off` included: it means Can't swim now, so they struggle and sink on the swim plan; only a video mocap take in water too deep to stand in floats at the waterline, which the body can't follow: "floats in the water"; where the water is shallow enough to stand in, auto and Can't swim wade on the bottom and the lifelike body shows), are moved by physics (a baked fall) or were knocked over (a saved tilt, from a knock-over or the Rotate gizmo, which writes the tilt as you drag), or have been driven live in this shot. Two exceptions are not whole-shot. A jump, hop up or vault (or a drop off an edge) shows the clay **only on the frames the person is in the air** (the clips have no jump: mid-air the body would walk, while the clay tucks its knees); on the ground before and after it is the lifelike body, so the body swaps at take-off and again at landing. Which frames are "in the air" is the same ballistic height table the clay uses (`stage._airborneAt`), kept up to date with the shot's fps and with any move or edit of the thing jumped onto; a crate, step or riser counts as climbable by its height above the floor it stands on (a station platform's 0.92 m floor included), not its height above the stage. The other: while a person is knocked over live in a physics drag (the live world's pose, before it is written down) they show as clay; `live.mjs` flags that from the physics pose (`markLiveTilt`), not from the clay group's rotation, so the ordinary lean of a walk or run (into turns, starting, stopping) never swaps the body. The dust matte keeps the hair and lash cut-outs too. Hover the **Face** control to see why someone is clay (re-read each time you hover).

## Controls

- **Face** (the Appearance row, with a person selected): `shown` (default) or `faceless`. Faceless keeps the head's shape and paints the face one flat skin colour: no painted brows, eyes or lips, no lashes, and the **hair stays** (see below). Saved on the person as `face: "faceless"`. The Pose pass draws a faceless person without the 68 face landmarks and without eye and ear points (the nose and neck stay, so the body still has a head).
- **Blocking** (beside Wire / Clay / Color / Depth: it is for the whole scene): every person shows as the clay figure. Only the look changes; the walk, keys and passes run the same. Saved with the scene as `people_look: "blocking"`.

### How faceless keeps the hair

Rocketbox puts hair in two places, and faceless keeps both:

- **Painted on the head texture** (`<id>_head`): most of the scalp hair (the woman's whole scalp and her ponytail roots; the man's brows are painted there too). Faceless no longer swaps the head for a plain material: it keeps the head's own texture and paints only the **face** one flat skin colour, sampled (blurred) from the avatar's own cheek. The face is a per-vertex mask (`faceMask`, `avatarcore.faceMaskAt`), computed once in the bind pose in eye spacings from the point between the eyes: from under the chin up to just above the brows (fading out before the hairline), across to the outer cheeks (before the ears and temples), and only in front of the ears. Brows, eyes (the eyeballs become skin-coloured), lips and nostrils go; the head keeps its shape, and the hair, ears and neck keep their texture.
- **Cards** (`<id>_opacity`): one material and one texture for hair strands AND lashes (in `f001` the lashes are a corner of the hair atlas; `m002`'s atlas is all hair). Skinning doesn't separate them (the woman's lower lashes ride the head bone like her hair), so `buildKit` splits the triangles by position, once, in the bind pose: a card triangle within 0.6 eye spacings of an eye bone and in front of the eyes is a lash or brow and moves to its own material `<id>_opacity_lashes` (same texture). Measured on the real files: the woman's 208 lash triangles all lie within 0.37 spacings and her nearest hair card is 3.3 spacings away; the man has no card within 0.83 spacings, so nothing of his is split (`kit.report.lashTriangles`). Faceless hides `_opacity_lashes`; `_opacity` (the hair) stays.

Checked in a browser (both avatars, close-up, Color pass): hair, ponytail and ears kept; brows, eyes and lips gone. Still rough: the flat face colour can sit a shade off the neck (the man's face reads a little greyer), and the normal map still carries the brow ridge and lip line.

The pure rules are in `avatarcore.mjs` and tested in `tests/js/avatars.test.mjs`; that test also parses the real files when they are installed.

The selection and hover outlines follow the cards too: a lifelike person's outline proxies draw each geometry group with its own material, so the hair and lash cards keep their cut-out shape and Faceless's hidden lashes stay hidden (viewport only, `web/stage/outline.mjs`). Tools that edit people from code (duplicate one, place one in frame) use the calls in [../STAGE_API.md](../STAGE_API.md).
