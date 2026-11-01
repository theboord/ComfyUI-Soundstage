#!/usr/bin/env python3
"""Contact sheets: one per scene and renderer, a row per run, a column per SHEET frame (sheet_frames.json).

  python3 tools/physbench/make_sheets.py --runs bl_default,ss_after,ss_before --outdir <dir>
      [--frames out]   (reads <frames>/frames_wb/<run>/ and <frames>/frames_clay/<run>/)
"""
import json, os, sys
from PIL import Image, ImageDraw, ImageFont

here = os.path.dirname(os.path.abspath(__file__))
argv = sys.argv[1:]
opt = {argv[i][2:]: argv[i + 1] for i in range(0, len(argv) - 1, 2)}
runs = opt.get("runs", "bl_default,ss_after").split(",")
names = dict(r.split("=", 1) for r in opt.get("names", "").split(",") if "=" in r)
outdir = opt.get("outdir", os.path.join(here, "out", "report"))
frames_root = opt.get("frames", os.path.join(here, "out"))
sheet = json.load(open(os.path.join(here, "sheet_frames.json")))
scenes = {s["name"]: s for s in json.load(open(os.path.join(here, "scenes.json")))["scenes"]}
FPS = 24
TW, TH, LBL, HDR = 320, 180, 170, 34
try:
    font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 15)
    small = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 13)
except OSError:
    font = small = ImageFont.load_default()
os.makedirs(outdir, exist_ok=True)
for kind, sub in (("workbench", "frames_wb"), ("clay", "frames_clay")):
    for name, frames in sheet.items():
        rows = [r for r in runs if os.path.isdir(os.path.join(frames_root, sub, r))]
        if not rows:
            continue
        img = Image.new("RGB", (LBL + TW * len(frames), HDR + 24 + TH * len(rows)), (24, 26, 30))
        d = ImageDraw.Draw(img)
        title = f"{scenes[name]['title']}  -  {'Blender Workbench' if kind == 'workbench' else 'Soundstage clay'} render, same camera"
        d.text((10, 8), title, fill=(235, 235, 235), font=font)
        for j, f in enumerate(frames):
            d.text((LBL + j * TW + 6, HDR + 4), f"f{f}  t={f / FPS:.2f}s", fill=(190, 190, 190), font=small)
        for i, r in enumerate(rows):
            y = HDR + 24 + i * TH
            d.text((10, y + TH // 2 - 9), names.get(r, r), fill=(235, 235, 235), font=font)
            for j, f in enumerate(frames):
                p = os.path.join(frames_root, sub, r, f"{name}_{f:04d}.png")
                if os.path.exists(p):
                    img.paste(Image.open(p).convert("RGB").resize((TW, TH), Image.LANCZOS), (LBL + j * TW, y))
            d.line([(0, y), (img.width, y)], fill=(60, 60, 66))
        out = os.path.join(outdir, f"sheet_{name}_{kind}.png")
        img.save(out)
        print("wrote", out)
