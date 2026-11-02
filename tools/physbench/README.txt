physbench: Soundstage physics against other engines (Blender Bullet now, Houdini later)

The scenes are in scenes.py, and running it writes scenes.json. Every runner reads that file, so all engines get
identical scenes:
  s1_drop     box dropped 2 m
  s2_tower    20-box tower, hit at 3 s
  s3_pyramid  10-crate pyramid hit by a braking kinematic car
  s4_ramp     30 deg ramp with an analytic answer
  s5_fracture s3 with breakable wood crates (Milestone 27: Voronoi cells, glue / bend / crack network) and the car's
              raked collision hull. Soundstage only: run_blender.py has no glue network, so Bullet treats the crates as
              rigid there. The Soundstage run also writes each broken prop's pieces (fractures) and the CPU time.

1. Soundstage (XPBD bake). Node, from the repo root:
     node tools/physbench/run_soundstage.mjs --label ss_after
   Options:
     [--substeps 20] [--iterations N] [--physics other/physics.mjs]   (for tuning experiments)

2. Blender (Bullet), headless. Copy run_blender.py and scenes.json, then:
     Blender --background --factory-startup --python run_blender.py -- --label bl_default
   Options:
     [--substeps 10] [--iterations 10] [--damping default|matched]

3. Houdini or anything else: write the same JSON:
     {engine, label, settings, fps, scenes: {<name>: {frames, ms, tracks: {<body id>: [[x,y,z,qx,qy,qz,qw] per frame]}}}}
   Coordinates are y-up, positions are box centres, and frame 0 is the start pose.
   Materials in scenes.json are effective pair values. Convert them to the engine's combine rule; see
   run_blender.py for the Bullet version.

4. Compare:
     python3 tools/physbench/analyze.py out/ss_after.json out/bl_default.json [more] \
         --pair ss_after,bl_default --outdir out/report
   This writes metrics.json, metrics.md and the charts.

5. Contact sheets. The frames rendered are the ones listed in sheet_frames.json.
   Workbench:
     Blender ... --python render_workbench.py -- --run out/<run>.json --outdir out/frames_wb
   Soundstage clay:
     python3 tools/physbench/render_clay_server.py 18791
     then open http://localhost:18791/tools/physbench/render_clay.html?runs=out/a.json,out/b.json
   Then:
     python3 tools/physbench/make_sheets.py --runs bl_default,ss_after --outdir out/report

Results from 2026-11-01: share/Physics_vs_Blender/REPORT.txt
