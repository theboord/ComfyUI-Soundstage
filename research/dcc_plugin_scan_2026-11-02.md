# DCC plugin scan: what third-party Blender / Houdini / Unreal / Nuke tools can teach Soundstage

*Research only, 2026-11-02. Nothing here is built. The lead Claude decides what to build.*

Mike's question: third-party plugin makers extend Houdini, Unreal, Blender and Nuke "almost like LoRAs do for AI". Do any of them have code or ideas Soundstage can use?

Short answer: yes. Some of the best ideas come from paid or GPL plugins, so we can only learn from how they work. But a good share of the most useful work sits under MIT, BSD, Apache or CC0. That code or data can go into Soundstage (MIT) as long as we credit it in `THIRD_PARTY_NOTICES.md`.

## How the licences were checked

- For every repo below I downloaded and read the licence file itself (`LICENSE`, `COPYING`, `license.txt` and so on) from the default branch on 2026-11-02, using `raw.githubusercontent.com/<repo>/HEAD/...`. I did not trust badges or marketplace pages. The GitHub API was blocked in this session, so I fetched the files directly. Where a repo has no root licence, I read the per-file headers or the README's licence section and say so.
- **Code reusable with attribution:** MIT, BSD-2/3, Apache-2.0, CC0 (and the SideFX Labs BSD-style licence). Keep the copyright notice, add a row to `THIRD_PARTY_NOTICES.md`, and for Apache-2.0 keep any NOTICE file.
- **Idea only:** GPL, AGPL, LGPL (in practice: we would be porting rather than linking, and porting LGPL code into MIT files is not allowed), proprietary, EULA, Unity Companion, research or non-commercial. We may read how it works and re-implement the algorithm from the published maths in our own words. We may not copy code, shaders or data.
- **The Blender rule:** Blender add-ons that import `bpy` are GPL by Blender's own policy. Every Blender add-on below is idea-only unless it says otherwise. One exception is common: the data or the core engine is under a separate, permissive licence (Camera Shakify's shake data, MakeHuman's assets, FLIP Fluids' engine). Those parts are flagged.
- What Soundstage already has comes from `README.md`, `CHANGELOG.md` and a quick look at `web/stage/*.mjs`. Examples: handheld shake is a sum of seeded sines (`web/stage/camrig.mjs` `noise()`), and water is a sum of deep-water sine waves (`web/stage/water.mjs`). The repo has no navmesh, no crowd or traffic system, no motion matching or inertialization, no Cryptomatte, no lens-distortion / ST-map export, and no cloth self-collision (the CHANGELOG says so). ("Recast" in the README means recasting an actor in real footage, not the Recast navmesh.)

## Ranked top 10

Impact means impact for a film-set App: judges see it, directors want it, and it makes the AI render follow the blocking better. Effort: S = about a day, M = 2–4 days, L = a week or more.

| # | What to build | Learned from | Licence (read from file) | Reuse | Impact | Effort |
|---|---|---|---|---|---|---|
| 1 | **Real recorded camera shake** for handheld, Steadicam, car mount and earthquake, replacing the sum-of-sines `noise()` | Camera Shakify (Blender) | add-on code **GPL-3**; shake data in `shake_data.py` **CC0** | **Data reusable** (CC0); code idea-only | High: every handheld shot feels filmed | S |
| 2 | **Inertialization + spring-damper toolkit**: seamless blends between gaits, mocap clips and stunts; critically damped springs for camera follow, horse/rider and car body | Daniel Holden's Motion-Matching and Spring-It-On (the method behind Unreal's motion matching) | **MIT** (both) | **Code reusable** | High: no pops between walk→run→mount, or between a mocap clip and a keyed pose | M |
| 3 | **Extras and crowds**: background action that walks, queues and avoids the cast and props, filling the breakdown's "extras" | Houdini crowds, Golaem/Miarmy (idea); RVO2, recast-navigation-js, Yuka (code) | RVO2 **Apache-2.0**; recast-navigation-js **MIT**; Yuka **MIT**; CrowdMaster (Blender) **GPL-3** | **Code reusable** (RVO2/Recast/Yuka) | High: empty streets are the biggest giveaway in a previz | M–L |
| 4 | **Cryptomatte in the VFX Layer Pack**: per-object and per-material ID mattes Nuke artists can pick | Psyop Cryptomatte (Nuke/Arnold/Blender standard) | **BSD-3-Clause** (`license.txt`) | **Code + spec reusable** | Medium-high: credibility with VFX pros; the ID pass already exists | M |
| 5 | **Cloth self-collision, two-way coupling, height-field water splashes and wakes** in the browser | Ten Minute Physics (Matthias Müller, the XPBD author) | **MIT**, in each file's header (the repo has no root licence) | **Code reusable** (plain JS) | Medium-high: fixes the CHANGELOG's own "no cloth self-collision" and adds boat wakes | S–M |
| 6 | **Sea states**: Beaufort 0–9 presets that drive a JONSWAP / FFT ocean (chop, swell, foam on crests) for the boats | Houdini Ocean Tools, Blender Ocean modifier (idea); gasgiant FFT-Ocean, jbouny/ocean (code) | FFT-Ocean **MIT**; jbouny/ocean **MIT**; Blender Ocean **GPL** | **Code reusable** (FFT-Ocean is Unity HLSL, so port to GLSL) | Medium-high: "rough sea" is a common slugline, and boats already ride `water.mjs` | M |
| 7 | **Ambient traffic** on city sets: lanes, junction yields, parked cars, pedestrians crossing | CARLA Traffic Manager (Unreal) | **MIT** (code). The README says CARLA's assets "can be used freely", and its Licenses section says "CARLA specific assets are distributed under the CC-BY License" (attribution required); read the asset licence before copying any mesh | **Code reusable** (C++, so port the rules) | Medium-high: car chases need cars to weave through | M–L |
| 8 | **Spring-bone secondary motion**: hair, horse mane and tail, straps, antennas, a cop's radio cord | KawaiiPhysics (Unreal), Wiggle 2 (Blender) | KawaiiPhysics **MIT**; Wiggle 2 **GPL-3** | **Code reusable** (KawaiiPhysics, port C++ to JS) | Medium: life in every gallop and run | S–M |
| 9 | **Body variety for the cast**: height, weight, age and proportion morphs, plus CC0 clothing proxies | MakeHuman / MPFB (Blender) | MakeHuman code **AGPL**, MPFB code **GPL-3**; their bundled **assets CC0** (`LICENSE.md`) | **Assets reusable** (CC0); code idea-only | Medium-high: a cast that doesn't look cloned | M–L |
| 10 | **Procedural set dressing**: buildings by floor/bay/window rules, rooms furnished by constraints, forests | Infinigen (Princeton), building_tools (Blender), SideFX Labs building and tree tools | Infinigen **BSD-3**; building_tools **MIT** (unusual for a Blender add-on, but that is what its `LICENSE` file says; code still imports `bpy`, so port the logic); SideFX Labs **BSD-style** (`LICENSE.md`) | **Logic reusable** (port from Python/Blender or VEX) | Medium: faster, richer sets; Video→3D already covers real locations | L |

Just outside the top 10: **fSpy-style "match a still"** (GPL-3, idea only; the vanishing-point maths is published and can be re-implemented) and **lens distortion + ST-map export** for the Layer Pack (Nuke practice; lensfun is GPL/LGPL, so re-implement the Brown–Conrady model from the public maths).

---

## The top 10 in detail

### 1. Camera Shakify: real recorded shake (CC0 data)
- **Link:** https://github.com/EatTheFuture/camera_shakify (Blender add-on, also on the Blender Extensions platform)
- **What it does:** applies real camera shake, recorded from physical cameras (handheld, walking, running, vehicle, earthquake and so on), to a Blender camera as F-curves, with scale and speed controls.
- **Licence (README "License" section, plus `LICENSE_CODE.md` and `LICENSE_DATA.md`):** "The code in this addon is licensed under the GNU General Public License, version 3… The camera shake data is CC0." `LICENSE_DATA.md`: "The camera shake data in `shake_data.py` is dedicated to public domain… via CC0."
- **For us:** take only `shake_data.py`, the recorded rotation/translation curves, as a JSON asset under `web/stage/`. Then let `camrig.mjs` sample it in place of the sum-of-sines `noise()` for the "high = shake (kept)" array, scaled by rig and seeded per shot so it stays deterministic. Map handheld → handheld walk/run, Steadicam → slow float, car mount → vehicle, impact jolt → a short burst. Do not copy any of the add-on's Python. Crediting EatTheFuture is not required for CC0, but it is good form.

### 2. Daniel Holden: Motion-Matching and Spring-It-On (MIT)
- **Links:** https://github.com/orangeduck/Motion-Matching and https://github.com/orangeduck/Spring-It-On (articles at theorangeduck.com)
- **What they do:** a reference C++ motion-matching controller (a feature database with pose search), plus a small library of critically damped springs, a timed spring, a "double spring" and **inertialization**: blend from any pose to any clip by decaying the offset, with no crossfade and no foot-sliding pop. Holden co-wrote Ubisoft's Learned Motion Matching, and Unreal's motion-matching / inertialization nodes use the same method.
- **Licence:** both `LICENSE` files: "MIT License, Copyright (c) 2021 Daniel Holden".
- **For us:** port the spring and inertialization functions (about 200 lines) to `web/stage/`. Uses: (a) gait changes in `gait.mjs` and transitions in and out of a mocap clip or a stunt; (b) camera follow targets in `camrig.mjs`, where the same zero-lag behaviour could replace or complement the zero-phase springs; (c) car body squat and roll in `vehsim.mjs`, and the horse/rider coupling. Full motion matching (pose search over a mocap database) is the bigger follow-on for "mocap them from any clip". Credit Holden in the notices.

### 3. Extras and crowds: RVO2 + recast-navigation-js + Yuka
- **Links:** https://github.com/snape/RVO2 · https://github.com/isaac-mason/recast-navigation-js · https://github.com/Mugen87/yuka. Ideas from Houdini crowds, Golaem, Miarmy (proprietary) and CrowdMaster (Blender, https://github.com/johnroper100/CrowdMaster).
- **What they do:** RVO2 is ORCA reciprocal collision avoidance (the standard for crowds). recast-navigation-js is Recast/Detour compiled to WASM, giving a navmesh from the set's meshes, path queries and a crowd agent manager. Yuka is a JS game-AI library with steering behaviours, state machines and path following, and it was written for three.js.
- **Licences:** RVO2 `LICENSE`: Apache License 2.0. recast-navigation-js `LICENSE`: "The MIT License, Copyright © 2025 Isaac Mason" (it wraps Recast, which is zlib). Yuka `LICENSE`: "The MIT License, Copyright © 2023 Yuka authors". CrowdMaster `LICENSE`: GNU GPL v3, idea only.
- **For us:** an "Extras" brush. Paint a zone or a path, pick a count and a behaviour (walk by, queue, mill, flee from the crash), and the agents use the existing gait system on the navmesh, avoid the cast, cars and props, and get keyed into the shot like any actor. Golaem's idea worth learning: crowds are a few motion clips re-timed and varied per agent, plus a cheap "billboard" level of detail. For us, far extras can stay simple clay. Also: a fleeing crowd reacting to stunts or fracture events is a strong demo moment.

### 4. Cryptomatte (BSD-3)
- **Link:** https://github.com/Psyop/Cryptomatte
- **What it does:** the industry-standard ID matte format, supported in Nuke, Fusion, After Effects, Arnold, V-Ray, Redshift, Blender and others. Each pixel stores ranked (ID-hash, coverage) pairs in EXR channels, plus a manifest. In Nuke the artist clicks an object to get its matte.
- **Licence:** `license.txt`: "Copyright (c) 2014, 2015, 2016 Psyop Media Company, LLC. All rights reserved. Redistribution and use in source and binary forms, with or without modification…", the BSD-3-Clause text.
- **For us:** Soundstage already renders an ID pass and exports a VFX Layer Pack. Write that pass as a Cryptomatte EXR (object and material layers, with the manifest in the EXR metadata) so a Nuke or Resolve artist can key any prop or person from a Soundstage take. The spec PDF and the reference Nuke gizmo/Python are in the repo. The hash is MurmurHash3, which is public domain. Soundstage already writes EXRs without the OpenEXR wheel (`soundstage/layerpack/exr.py`: float32 channels with any name, plus string header attributes, which the Cryptomatte manifest needs). Credit Psyop.

### 5. Ten Minute Physics (MIT per file)
- **Link:** https://github.com/matthias-research/pages, folder `tenMinutePhysics/` (`11-hashing`, `14-cloth`, `15-selfCollision`, `17-fluidSim`, `18-flip`, `20-heightFieldWater`, `21-fire`, `22-rigidBodies`, `25-joints`)
- **What it does:** single-file browser demos (three.js / canvas) by the inventor of PBD/XPBD: cloth with self-collision through spatial hashing, height-field water with two-way coupled floating bodies, FLIP fluid, 2D smoke and fire, and rigid bodies with joints.
- **Licence:** there is no root licence file. Each HTML file I checked (`10-softBodies`, `14-cloth`, `15-selfCollision`, `18-flip`, `20-heightFieldWater`) opens with "Copyright 202x Matthias Müller - Ten Minute Physics" and the full MIT permission text. Re-check the header of any file before porting it.
- **For us:** `web/stage/softbody.mjs` is already XPBD, so these drop in close to as-is. (a) Spatial-hash self-collision for cloth, which the CHANGELOG lists as missing. (b) Height-field water around boats and swimmers: a local splash and wake grid on top of the `water.mjs` sine field, with two-way coupling, so a speedboat leaves a V-wake and a diver makes rings. (c) `21-fire` as a cheap fire and smoke guide for the clay pass. Keep his copyright notice in each ported file.

### 6. Sea states: FFT ocean (MIT)
- **Links:** https://github.com/gasgiant/FFT-Ocean (Unity, HLSL compute) · https://github.com/jbouny/ocean (three.js). Ideas from Houdini Ocean Tools, the Blender Ocean modifier (GPL) and Unreal's Water plugin.
- **What they do:** Tessendorf FFT ocean. FFT-Ocean adds the JONSWAP spectrum, several cascades, and foam from the Jacobian (whitecaps where the surface folds). jbouny/ocean is an older three.js FFT ocean in plain WebGL.
- **Licences:** FFT-Ocean `LICENSE`: "MIT License, Copyright (c) 2020 Ivan Pensionerov". jbouny/ocean `LICENSE`: "The MIT License (MIT) Copyright (c) 2013 Jérémy Bouny".
- **For us:** keep `water.mjs`'s "one wave field shared by everything" design (caustics, Snell's window, currents), but generate the wave list from a spectrum. A **Sea state** control (Beaufort 0–9, or wind speed and fetch) sets JONSWAP's parameters. A cheap version is about 64 spectrum-sampled Gerstner waves on the CPU, which keeps the pure-function, repeatable design and the boat buoyancy tests. The full FFT can be a GPU option. Jacobian foam also gives the Look compiler words ("whitecaps", "spray off the crests") that match the clay. Credit Pensionerov and/or Bouny for whatever is ported.

### 7. CARLA Traffic Manager (MIT)
- **Link:** https://github.com/carla-simulator/carla
- **What it does:** an open driving simulator on Unreal. Its Traffic Manager drives hundreds of cars with lane following, junction priority, safe gaps, lane changes, and per-vehicle "aggression" and speed offsets.
- **Licence:** `LICENSE`: "MIT License, Copyright (c) 2024 Computer Vision Center (CVC) at the Universitat Autonoma de Barcelona (UAB)". The README says its digital assets (urban layouts, buildings, vehicles) "can be used freely", and its Licenses section says "CARLA specific assets are distributed under the CC-BY License" (attribution required). Read the asset licence in the asset catalogue before copying any mesh; I did not verify it here.
- **For us:** a "Traffic" layer for city and highway sets, modelled on the Traffic Manager's rules: lanes from the set's road splines, cars that yield, brake for the hero car and swerve from a stunt. Use our own Quaternius CC0 cars, already in the repo. A J-turn or chase through live traffic is a strong film moment. Also worth a look: Microsoft AirSim (`LICENSE`: "The MIT License (MIT)") for drone flight dynamics behind the drone and FPV camera rigs.

### 8. KawaiiPhysics: spring-bone secondary motion (MIT)
- **Link:** https://github.com/pafuhana1213/KawaiiPhysics (Unreal AnimNode plugin)
- **What it does:** cheap pseudo-physics for bone chains (hair, skirts, tails, accessories): a Verlet step per bone with damping and stiffness curves along the chain, gravity, wind, limit spheres and capsules, and planar limits. It is widely used in Unreal for exactly this job.
- **Licence:** `LICENSE`: "MIT License, Copyright (c) 2019-2026 pafuhana1213". Wiggle 2 for Blender (https://github.com/shteeve3d/blender-wiggle-2) does the same and is **GPL-3**, idea only.
- **For us:** a small `springbones.mjs` that runs after the gait and pose passes, for the horse's mane and tail, ponytails and long hair, coat tails, straps, antennas and a dangling cable, with the existing body capsules as colliders. It is deterministic if stepped at a fixed rate from frame 0. Port the algorithm from the C++ and credit it.

### 9. MakeHuman assets (CC0) for body variety
- **Links:** https://github.com/makehumancommunity/makehuman · https://github.com/makehumancommunity/mpfb2 (Blender)
- **What they do:** a parametric human body. Morph targets for gender, age, weight, muscle, height and proportions, plus proxies, clothes, hair and a skeleton.
- **Licences:** MakeHuman `LICENSE.md`: "The MakeHuman source… is released under AGPL… The assets… have been released under CC0 1.0 Universal" (full text in `LICENSE.ASSETS.md`). MPFB `LICENSE.md`: "MPFB uses the same license setup as MakeHuman, but with GPLv3 as source code license… These assets have been released under CC0." **Code is idea-only; assets are reusable.**
- **For us:** pre-bake a small set of CC0 morph deltas (height, weight, age, build) onto our people's mesh, or swap our body to MakeHuman's CC0 base mesh, so the casting step gives every character a distinct silhouette that the ID/depth guide carries into the render. Check which asset packs are bundled (and so CC0) and which are separate community uploads with their own licences. Effort is mostly retargeting to the existing rig.

### 10. Procedural set dressing: Infinigen, building_tools, SideFX Labs
- **Links:** https://github.com/princeton-vl/infinigen · https://github.com/ranjian0/building_tools · https://github.com/sideeffects/SideFXLabs
- **What they do:** Infinigen generates photoreal nature scenes and furnished indoor rooms (Infinigen Indoors places furniture with a constraint solver: against walls, facing the TV, clearance for doors). building_tools builds facades from floors, bays, windows, doors and balconies. SideFX Labs ships Houdini HDAs such as building generators, a tree generator, lot subdivision, cables and scatter.
- **Licences:** Infinigen `LICENSE`: "BSD 3-Clause License, Copyright (c) 2023, Princeton University". building_tools `LICENSE`: "MIT License, Copyright (c) 2019 Ian Karanja". SideFX Labs `LICENSE.md`: "Copyright (c) 2026 Side Effects Software Inc… Redistribution and use… are permitted provided that… Redistributions of source code must retain the above copyright notice… The name of Side Effects Software may not be used to endorse…", a permissive BSD-style licence. All three are reusable with attribution, but the code depends on Blender (`bpy`) or Houdini (HDAs/VEX), so in practice we port the rules and parameter tables, not the code.
- **For us:** (a) a "Furnish room" button for interior sets using Infinigen-style constraints, so a slugline like *INT. KITCHEN* gets a believable layout that the Director's model can then adjust; (b) building blocks for City sets from building_tools' floor/bay grammar; (c) a tree generator for forest sets (see also ez-tree below). The furnishing solver is the most novel and the most work.

---

## Everything else checked, by ecosystem

Reuse key: **R** = code or data reusable with attribution, **I** = idea only.

### Houdini
| Name | Link | What it does | Licence (from file) | | Idea for Soundstage |
|---|---|---|---|---|---|
| SideFX Labs | github.com/sideeffects/SideFXLabs | Hundreds of free HDAs: game/VFX tools, photogrammetry clean-up, trees, buildings, cables, baking, motion-vector flipbooks | BSD-style, SideFX (`LICENSE.md`) | R (Houdini-only) | Port logic only (see #10). Labs' "Lot Subdivision" and "Road generator" are good references for City set layout |
| qLib | github.com/qLab/qLib | Long-running community HDA library (gallery, utilities, camera tools) | BSD-3 (`LICENSE`, "Neither the name of qLab…") | R (Houdini-only) | Mostly Houdini workflow. The camera frustum / culling and "align to ground" tools are worth reading for the stage |
| MOPs (Motion Operators) | github.com/toadstorm/MOPS | Motion-graphics instancing toolkit (falloffs, transforms, aim, noise) | **LGPL-3** (`LICENSE`) | I | The falloff-driven "effector" idea (offset, aim, noise by a field) would suit set dressing and crowd variation |
| Axiom | (commercial, theory-animation) | GPU sparse smoke/fire solver for Houdini | proprietary | I | Fire and smoke in the clay could be a cheap 2D/3D grid guide (see Ten Minute Physics `21-fire`, MIT) |

### Blender (Extensions platform, Superhive / Blender Market)
| Name | Link | What it does | Licence | | Idea |
|---|---|---|---|---|---|
| Camera Shakify | github.com/EatTheFuture/camera_shakify | Recorded camera shake | code GPL-3, **data CC0** | R (data) | #1 |
| FLIP Fluids | github.com/rlguy/Blender-FLIP-Fluids | FLIP liquid sim with whitewater (foam/bubble/spray) | add-on **GPL-3**; **simulation engine MIT** (`LICENSE_MIT.md`, README: "The FLIP Fluids simulation engine is licensed under the MIT license"); paid content Royalty-Free | R (engine, C++) | Its whitewater classification (spray if airborne and fast, foam at the surface, bubbles below) could drive our particle system's spray at bows and wakes. Port from the engine's MIT sources (per-file headers state the licence) |
| Rigacar | github.com/digicreatures/rigacar | Car rig: wheels spin from path, suspension, steering | GPL-3 | I | Soundstage already has `vehsim.mjs`. The "bake wheel rotation from path" idea is covered |
| CrowdMaster | github.com/johnroper100/CrowdMaster | Node-based crowd sim | GPL-3 | I | #3 (use RVO2/Recast instead) |
| fSpy + fSpy-Blender | github.com/stuffmatic/fSpy | Camera match from vanishing points in one still | GPL-3 (both) | I | "Match a reference photo": draw two or three vanishing lines on a location still, get focal length and camera pose, and set the stage camera to it. Re-implement from the published maths |
| building_tools | github.com/ranjian0/building_tools | Procedural buildings | **MIT** | R | #10 |
| Gaffer | github.com/gregzaal/Gaffer | Light manager (list, solo, HDRI) | GPL (header in `__init__.py`) | I | A one-glance light list with solo and mute for `lightrig.mjs`; small UI win |
| MPFB / MakeHuman | github.com/makehumancommunity/mpfb2 | Parametric humans | code GPL-3 / AGPL, **assets CC0** | R (assets) | #9 |
| Wiggle 2 | github.com/shteeve3d/blender-wiggle-2 | Spring bones | GPL-3 | I | #8 (use KawaiiPhysics, MIT) |
| Animation Nodes | github.com/JacquesLucke/animation_nodes | Node-based procedural animation | GPL-3 (`license.txt`) | I | — |
| BlenderGIS | github.com/domlysz/BlenderGIS | Terrain/OSM/satellite import | GPL-3 | I | Real-place terrain with OSM building footprints for a location set (or use Cesium, below) |
| Auto-Rig Pro, Launch Control / Traffiq, RBDLab, Physical Starlight & Atmosphere, Photographer, Geo-Scatter, Simply Cloth, KeenTools GeoTracker | Superhive / vendor sites | Rigging, car rigs, destruction, sky, physical camera, scattering, cloth, object tracking | proprietary | I | What to copy is the UX, not code. Physical Starlight: a sky that is physically right for any sun angle (we have solar position; an atmosphere model like Hillaire 2020 is published). Photographer: exposure from ISO, shutter and f-stop with real motion blur from the shutter angle, which the Look could state. RBDLab: "fracture by impact location" plus debris emitters (we have Voronoi fracture). Traffiq: a library of drivable cars with consistent rigs |

### Unreal (Fab and open-source GitHub)
| Name | Link | What it does | Licence | | Idea |
|---|---|---|---|---|---|
| KawaiiPhysics | github.com/pafuhana1213/KawaiiPhysics | Spring bones | **MIT** | R | #8 |
| CARLA | github.com/carla-simulator/carla | Driving sim and Traffic Manager | **MIT** (code) | R | #7 |
| AirSim | github.com/microsoft/AirSim | Drone and car sim | **MIT** | R | Quadrotor dynamics for a more physical drone/FPV rig |
| Cesium for Unreal | github.com/CesiumGS/cesium-unreal | 3D Tiles: real-world terrain and cities | **Apache-2.0** | R | A "real place" set (CesiumJS for the browser is also Apache-2.0). Caution: Google Photorealistic 3D Tiles have their own terms of service; OSM buildings are ODbL |
| ALS-Community | github.com/dyanikoglu/ALS-Community | C++ port of Advanced Locomotion System v4 | MIT, but the header says it is a port of the Marketplace blueprints ("LongmireLocomotion as developer of the blueprints used as reference") | I (treat as idea; its origin is a Marketplace product) | Overlay layering (upper-body pose over locomotion), lean into turns, foot-locking. Good reference for rider and carry poses |
| Prefabricator | github.com/coderespawn/prefabricator-ue4 | Prefabs and randomised prefab collections | **MIT** | R | "Randomise this prop group" for set dressing; Soundstage Presets are close already |
| ozz-animation | github.com/guillaumeblanc/ozz-animation | Runtime skeletal animation (sampling, blending, IK, compression) | **MIT** (`LICENSE.md`) | R | Additive layers and two-bone/aim IK references |
| Fab: Ultra Dynamic Sky/Weather, Easy Road/Road Creator, Mass (built in), Chaos Vehicles (built in), Advanced Locomotion System (Fab) | fab.com / Epic | Sky and weather presets, splines to roads, crowds, vehicles | proprietary / Epic EULA | I | Weather presets that change sky, wetness, puddles and particles together (we have rain); road splines with kerbs and lane markings for City sets |

### Nuke (Nukepedia and open gizmos)
| Name | Link | What it does | Licence | | Idea |
|---|---|---|---|---|---|
| Cryptomatte | github.com/Psyop/Cryptomatte | ID mattes | **BSD-3** | R | #4 |
| Nuke Survival Toolkit | github.com/CreativeLyons/NukeSurvivalToolkit_publicRelease | Curated pack of about 200 community gizmos | **MIT** for the pack (`LICENSE`). Each gizmo keeps its original author, so check the gizmo's header before reusing one | R (per gizmo) | Reference for finishing ops (grain, glow, lens) behind the Film Finish and Layer Pack. A "Soundstage.nk" comp template that loads the Layer Pack with the passes already wired would delight Nuke users |
| Nukepedia gizmos | nukepedia.com | Thousands of gizmos | per item, often no licence stated | I unless a licence is stated | — |
| lensfun | github.com/lensfun/lensfun | Lens distortion/vignetting database and library | library **LGPL-3**, tools **GPL-3** (`COPYING`, README) | I | Export an **ST-map** and distortion metadata per lens in the Layer Pack, so CG can be re-distorted to match. Re-implement the Brown–Conrady model ourselves |
| KeenTools, Optical Flares, Foundry Cattery models | vendors | Tracking, flares, ML models | proprietary / per model | I | — |

### Matchmove, camera and Video→3D
| Name | Link | What it does | Licence | | Idea |
|---|---|---|---|---|---|
| COLMAP | github.com/colmap/colmap | Structure-from-motion and MVS | **BSD-3** ("new BSD license"; dependencies have their own licences) | R | A classical fallback or refinement for the Video→3D camera solve, with lens intrinsics, which feeds the ST-map idea |
| GLOMAP | github.com/colmap/glomap | Global SfM, much faster than incremental COLMAP (archived; deprecated and merged into COLMAP as its global mapper) | **BSD-3** (ETH Zurich) | R | Same as COLMAP, faster |
| Cinemachine | github.com/Unity-Technologies/com.unity.cinemachine | Procedural cameras: composer dead and soft zones, group framing, dolly track, impulse shake | **Unity Companion License** ("for Unity-dependent projects") | I | Framing as a rule ("keep her eyes on the upper third, soft zone 10%") that keys the camera automatically; "frame the group" for two-shots; impulse-on-impact (we have jolts) |
| Storyboarder / Shot Generator | github.com/wonderunit/storyboarder | Storyboard app with a three.js 3D shot generator | **EULA** (`build/license_en.txt`, "End User License Agreement for Wonder Unit Software"), despite public source | I | The closest previz neighbour. Its quick pose library and "camera from a sketch" ideas are worth a look; take no code |
| AI4Animation | github.com/sebastianstarke/AI4Animation | Neural character controllers (PFNN, MANN for quadrupeds, DeepPhase) | README: "only for research or education purposes, and not freely available for commercial use or redistribution"; mocap data **CC BY-NC 4.0** | I | The DeepPhase / periodic-phase idea fits our gait cadences, but use the published papers only, never this code or data |

### Destruction, cloth, water, terrain (open, browser-friendly)
| Name | Link | What it does | Licence | | Idea |
|---|---|---|---|---|---|
| Ten Minute Physics | github.com/matthias-research/pages | XPBD cloth, self-collision, FLIP, height-field water, fire | **MIT** (per-file header) | R | #5 |
| three-pinata | github.com/dgreenheck/three-pinata | Real-time fracture and **plane slicing** for three.js | **MIT** (`lib/package.json` `"license": "MIT"` and `lib/LICENSE`; no root LICENSE) | R | We have Voronoi fracture. Its plane **slice** (a sword cut, a falling sign sheared in two, a car cut by a barrier) is new |
| NVIDIA PhysX 5 (with Blast) | github.com/NVIDIA-Omniverse/PhysX | Physics SDK including Blast destruction (support graphs, bonds) | **BSD-3** (`LICENSE.md`) | R | Blast's "support graph with bond health" is close to our "nails and wood fibre" network; a reference for damage spreading through a building |
| FFT-Ocean / ocean | (above) | FFT ocean | **MIT** | R | #6 |
| ez-tree | github.com/dgreenheck/ez-tree | Procedural trees for three.js | **MIT** | R | Varied trees for forest and park sets, drop-in |
| simplex-noise.js | github.com/jwagner/simplex-noise.js | 2D/3D/4D simplex noise | **MIT** | R | Terrain height, wind gust fields, cloud drift |
| MapGenerator | github.com/ProbableTrain/MapGenerator | Procedural city road networks (tensor fields) | **LGPL-3.0** (`COPYING` + `COPYING.LESSER`) | I | Tensor-field streets for a "generate a neighbourhood" City set; re-implement from the paper (Chen et al. 2008) |
| OpenTimelineIO | github.com/AcademySoftwareFoundation/OpenTimelineIO | Editorial interchange | **Apache-2.0** (`LICENSE.txt`) | R | Soundstage already exports OTIO; listed only for completeness |

---

## Attribution checklist (if any of this gets built)

For each reused piece, add a row to `THIRD_PARTY_NOTICES.md` (component, where it lives, licence, copyright) and keep the original notice in the ported file's header:

- Camera Shakify shake data: CC0, © EatTheFuture contributors (credit is courtesy, not required)
- Motion-Matching / Spring-It-On: MIT, © 2021 Daniel Holden
- RVO2: Apache-2.0, © University of North Carolina at Chapel Hill (keep the licence text and any NOTICE)
- recast-navigation-js: MIT, © 2025 Isaac Mason (plus Recast/Detour: zlib, © Mikko Mononen)
- Yuka: MIT, © 2023 Yuka authors
- Cryptomatte: BSD-3, © 2014–2016 Psyop Media Company, LLC
- Ten Minute Physics: MIT, © 2021–2022 Matthias Müller
- FFT-Ocean: MIT, © 2020 Ivan Pensionerov · jbouny/ocean: MIT, © 2013 Jérémy Bouny
- CARLA: MIT, © 2024 CVC / UAB
- KawaiiPhysics: MIT, © 2019–2026 pafuhana1213
- MakeHuman / MPFB assets: CC0
- Infinigen: BSD-3, © 2023 Princeton University · building_tools: MIT, © 2019 Ian Karanja · SideFX Labs: BSD-style, © Side Effects Software
- three-pinata: MIT, © Daniel Greenheck · ez-tree: MIT, © 2024 Daniel Greenheck

## Caveats

- Licences can change. Re-read the licence file at the exact commit you vendor, and pin that commit in the notices.
- RVO2: Apache-2.0 text read; no `NOTICE` file at the repo root (checked). The README gives the copyright as "2008 University of North Carolina at Chapel Hill".
- I read CARLA's asset licence only through its README: the Licenses section says "CARLA specific assets are distributed under the CC-BY License" (attribution required) and names no version. Read the asset catalogue licence before using any mesh.
- MakeHuman: only assets *bundled with MakeHuman* are CC0. Community-uploaded assets carry their own licences.
- Nuke Survival Toolkit: the MIT licence covers the pack. Individual gizmos credit their original authors; check each header.
- No code was run or benchmarked for this report. The effort figures are estimates.
