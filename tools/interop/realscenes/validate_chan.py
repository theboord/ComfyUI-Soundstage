"""Validate a Soundstage shot_cam.chan against the Nuke .chan format (frame tx ty tz rx ry rz vfov, degrees, ZXY)
and cross-check every line against camera.json (cam_to_world, focal) from the same kit."""
import json, math, sys, os
import numpy as np
kit = sys.argv[1]
shot = json.load(open(os.path.join(kit, "shot.json")))
cj = json.load(open(os.path.join(kit, "camera.json")))
lines = [l for l in open(os.path.join(kit, "shot_cam.chan")).read().splitlines() if l.strip()]
W, H = shot["resolution"]; sw = shot["sensor_width_mm"]; sh = sw * H / W
R = lambda a, ax: {"x": np.array([[1,0,0],[0,math.cos(a),-math.sin(a)],[0,math.sin(a),math.cos(a)]]),
                   "y": np.array([[math.cos(a),0,math.sin(a)],[0,1,0],[-math.sin(a),0,math.cos(a)]]),
                   "z": np.array([[math.cos(a),-math.sin(a),0],[math.sin(a),math.cos(a),0],[0,0,1]])}[ax]
errs, worst_t, worst_r, worst_f = [], 0, 0, 0
frames = cj["frames"] if isinstance(cj.get("frames"), list) else []
byf = {int(f.get("frame", i + shot["frame_start"])): f for i, f in enumerate(frames)}
for i, l in enumerate(lines):
    c = l.split()
    if len(c) != 8: errs.append(f"line {i+1}: {len(c)} columns"); continue
    v = [float(x) for x in c]
    fr = v[0]
    if fr != int(fr) or int(fr) != shot["frame_start"] + i: errs.append(f"line {i+1}: frame {fr}")
    if not (0 < v[7] < 180): errs.append(f"line {i+1}: vfov {v[7]}")
    if any(abs(a) > 720 for a in v[4:7]): errs.append(f"line {i+1}: rotation not in degrees?")
    # Nuke ZXY: R = Ry * Rx * Rz (rotate Z first, then X, then Y), translate in the file's units
    rx, ry, rz = [math.radians(a) for a in v[4:7]]
    Rm = R(ry, "y") @ R(rx, "x") @ R(rz, "z")
    f = byf.get(int(fr))
    if f:
        M = np.array(f["cam_to_world"])
        worst_r = max(worst_r, float(np.abs(M[:3, :3] - Rm).max()))
        worst_t = max(worst_t, float(np.abs(M[:3, 3] - np.array(v[1:4])).max()))
        foc = f.get("focal") or f.get("focal_mm")
        if foc:
            vf = math.degrees(2 * math.atan(sh / 2 / foc))
            worst_f = max(worst_f, abs(vf - v[7]))
print(json.dumps({"kit": os.path.basename(kit), "lines": len(lines), "frames": [lines[0].split()[0], lines[-1].split()[0]], "errors": errs[:5],
  "matched_camera_json": len(byf), "max_rot_matrix_diff": round(worst_r, 7), "max_translate_diff": round(worst_t, 7), "max_vfov_diff_deg": round(worst_f, 5),
  "sample": lines[0]}))
