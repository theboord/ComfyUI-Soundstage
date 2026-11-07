# Lifelike people (Microsoft Rocketbox avatars)

Men and women on the 3D stage can show as lifelike people instead of the clay figure. The clay figure is still there underneath and runs everything (walk, keys, gaze, mounts, mocap, Drive); only its meshes are hidden while the lifelike body shows. Children and everything else stay clay for now.

## Getting the files (they are not in the repo)

The avatars and clips come from [Microsoft Rocketbox](https://github.com/microsoft/Microsoft-Rocketbox), MIT licence, Copyright (c) 2020 Microsoft, pinned at commit `0943055db6ec570bcef9f2c8b41c9e5467c808f9`. Only fetch from that commit or a later one: before 2020-11-17 the library had a non-commercial licence.

They are kept out of git (about 27 MB). For now a maintainer puts them in `web/stage/people/rocketbox/` by hand; a one-click download from the pinned commit comes later. The folder holds:

| File | From the Rocketbox repo |
|---|---|
| `Male_Adult_01.fbx`, `Female_Adult_01.fbx` | `Assets/Avatars/Adults/<name>/Export/<name>.fbx` |
| `tex/m002_*.png`, `tex/f001_*.png` (body / head colour, normal, specular, and the opacity map) | the avatars' `Textures/*.tga`, shrunk to 1024 px PNG with macOS `sips`; the opacity PNG keeps its alpha |
| `anim/m_idle_neutral_01.max.fbx`, `m_walk_…`, `m_run_…`, `m_gestic_talk_…`, `f_idle_…`, `f_walk_…`, `f_run_…` | `Assets/Animations/all_animations_max_motextr_static/` and `_xy/` |
| `LICENSE.md` | the MIT licence, copied next to the files |

Without the folder every person silently stays clay (one line in the browser console says so).

## How it works

- `avatars.mjs` loads each avatar once (FBXLoader; every `.tga` the FBX names is loaded as `tex/<same name>.png`, because three's FBXLoader has no TGA reader here), keeps only the most detailed mesh, swaps its Phong materials for the Standard material the rest of the set uses, and clones it per person.
- The body plays its own Rocketbox clip: idle when still, walk, run, crossfaded by ground speed over about half a second. Walk and run advance with the distance travelled, so the feet don't skate; idle runs on the shot's frame clock. The pose depends only on the frame number, so renders are frame-exact.
- The clips' ground travel (on the root bone `Bip01`) is removed, keeping the up-and-down bob, because the person already moves along their keyed path.
- Depth, ID, Clay and Wire passes all draw the posed body. The Pose pass reads the lifelike body's real bones while it shows.

## When the clay shows instead

M1 can't yet make the lifelike body follow everything the clay can do. A person stays clay for the whole shot (never a swap mid-shot) when they ride or sit on something, are carried, carry something or hold a prop, play a video mocap take, have Pose keys or gaze keys, swim, or are driven live. Hover the **Face** control to see why someone is clay.

## Controls (Appearance row, with a person selected)

- **Face**: `shown` (default) or `faceless`. Faceless keeps the head's shape with a plain neutral material and no face, brows or lashes (a mannequin). Saved on the person as `face: "faceless"`.
- **Blocking look**: every person shows as the clay figure. Only the look changes; the walk, keys and passes run the same. Saved with the scene as `people_look: "blocking"`.

The pure rules are in `avatarcore.mjs` and tested in `tests/js/avatars.test.mjs`; that test also parses the real files when they are installed.
