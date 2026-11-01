#!/usr/bin/env python3
"""Compare physics benchmark runs (any engine that writes the runner JSON: Soundstage, Blender, later Houdini).

  python3 tools/physbench/analyze.py out/ss_default.json out/bl_default.json [more runs...] --outdir <dir>
         [--pair ss_default,bl_default]   (the two runs the headline charts compare; default: the first two)

Writes metrics.json, metrics.md (tables) and charts (*.png) to --outdir.
Metrics, per scene and run: settle time, final rest positions and spread, cross-run final-position difference, max
interpenetration (OBB separating-axis depth between every pair, plus floor sink), energy over time, stack stability
before the hit (tower), the analytic ramp check, first-contact time and rebound height (drop).
"""
import json, math, os, sys
import numpy as np

here = os.path.dirname(os.path.abspath(__file__))
argv = sys.argv[1:]
opt = {}
files = []
i = 0
while i < len(argv):
    if argv[i].startswith("--"):
        opt[argv[i][2:]] = argv[i + 1]; i += 2
    else:
        files.append(argv[i]); i += 1
outdir = opt.get("outdir", os.path.join(here, "out", "report"))
os.makedirs(outdir, exist_ok=True)
scenes = {s["name"]: s for s in json.load(open(opt.get("scenes", os.path.join(here, "scenes.json"))))["scenes"]}
runs = [json.load(open(f)) for f in files]
labels = [r["label"] for r in runs]
pair = opt.get("pair", ",".join(labels[:2])).split(",")
FPS = runs[0]["fps"]
LIN_STILL, ANG_STILL = 0.05, 0.1   # m/s, rad/s: "at rest"


def qmul(a, b):
    ax, ay, az, aw = a[..., 0], a[..., 1], a[..., 2], a[..., 3]
    bx, by, bz, bw = b[..., 0], b[..., 1], b[..., 2], b[..., 3]
    return np.stack([aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx,
                     aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz], -1)


def qconj(q):
    return q * np.array([-1, -1, -1, 1])


def rotmat(q):
    x, y, z, w = q
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
                     [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
                     [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)]])


def obb_overlap(ca, Ra, ha, cb, Rb, hb):
    """Penetration depth of two oriented boxes (min overlap over the 15 SAT axes), 0 when apart."""
    t = cb - ca
    axes = [Ra[:, i] for i in range(3)] + [Rb[:, i] for i in range(3)]
    for i in range(3):
        for j in range(3):
            c = np.cross(Ra[:, i], Rb[:, j]); l = np.linalg.norm(c)
            if l > 1e-6: axes.append(c / l)
    m = math.inf
    for L in axes:
        ra = sum(ha[k] * abs(Ra[:, k] @ L) for k in range(3))
        rb = sum(hb[k] * abs(Rb[:, k] @ L) for k in range(3))
        o = ra + rb - abs(t @ L)
        if o <= 0: return 0.0
        m = min(m, o)
    return m


CORNERS = np.array([[i, j, k] for i in (-1, 1) for j in (-1, 1) for k in (-1, 1)], float)


def analyse(sc, run):
    R = run["scenes"].get(sc["name"])
    if R is None: return None
    F = sc["frames"]; dt = 1 / FPS
    bodies = sc["bodies"]
    ids = [b["id"] for b in bodies]
    T = np.array([R["tracks"][i] for i in ids], float)   # [N, F, 7]
    P, Q = T[:, :, :3], T[:, :, 3:]
    Q = Q / np.linalg.norm(Q, axis=-1, keepdims=True)
    dyn = [k for k, b in enumerate(bodies) if b["type"] == "dynamic"]
    half = np.array([b["size"] for b in bodies]) / 2
    mass = np.array([b["mass"] for b in bodies])
    t = np.arange(F) * dt
    # Velocities (central differences) and angular velocity from the quaternion change.
    V = np.gradient(P, dt, axis=1)
    W = np.zeros_like(P)
    for k in range(len(bodies)):
        q = Q[k]
        # hemisphere-consistent neighbours
        dq = qmul(q[2:], qconj(q[:-2]))
        dq[dq[:, 3] < 0] *= -1
        ang = 2 * np.arctan2(np.linalg.norm(dq[:, :3], axis=1), dq[:, 3])
        ax = dq[:, :3] / np.maximum(np.linalg.norm(dq[:, :3], axis=1, keepdims=True), 1e-12)
        W[k, 1:-1] = ax * (ang / (2 * dt))[:, None]
    # Energy: kinetic (linear + rotational, box inertia in the body frame) + potential, dynamic bodies only.
    g = sc["gravity"]
    E_k = np.zeros(F); E_r = np.zeros(F); E_p = np.zeros(F)
    for k in dyn:
        ex = 2 * half[k]; m = mass[k]
        I = m / 12 * np.array([ex[1] ** 2 + ex[2] ** 2, ex[0] ** 2 + ex[2] ** 2, ex[0] ** 2 + ex[1] ** 2])
        E_k += 0.5 * m * (V[k] ** 2).sum(-1)
        E_p += m * g * P[k, :, 1]
        for f in range(F):
            wl = rotmat(Q[k, f]).T @ W[k, f]
            E_r[f] += 0.5 * (I * wl * wl).sum()
    E = E_k + E_r + E_p
    # Interpenetration per frame: every pair with a dynamic body in it, and floor sink.
    pen = np.zeros(F); floor = np.zeros(F)
    pairs = [(a, b) for a in range(len(bodies)) for b in range(a + 1, len(bodies)) if a in dyn or b in dyn]
    for f in range(F):
        Rm = [rotmat(Q[k, f]) for k in range(len(bodies))]
        worst = 0.0
        for a, b in pairs:
            if np.linalg.norm(P[a, f] - P[b, f]) > np.linalg.norm(half[a]) + np.linalg.norm(half[b]): continue
            worst = max(worst, obb_overlap(P[a, f], Rm[a], half[a], P[b, f], Rm[b], half[b]))
        pen[f] = worst
        sink = 0.0
        for k in dyn:
            y = P[k, f, 1] + (CORNERS * half[k]) @ Rm[k].T[:, 1]
            sink = max(sink, -y.min())
        floor[f] = sink
    # Settle: first time after the hit from which every dynamic body stays still.
    hit = sc.get("hit_frame", 0)
    moving = np.zeros(F, bool)
    for k in dyn:
        moving |= (np.linalg.norm(V[k], axis=1) > LIN_STILL) | (np.linalg.norm(W[k], axis=1) > ANG_STILL)
    moving[0] = moving[-1] = False   # gradient ends are one-sided
    idx = np.where(moving[hit + 1:F - 1])[0]
    settle = None if (len(idx) and idx[-1] + hit + 1 >= F - 3) else ((idx[-1] + hit + 2) * dt if len(idx) else hit * dt)
    fin = P[dyn, -1]
    cen = fin[:, [0, 2]].mean(0)
    spread = float(np.sqrt(((fin[:, [0, 2]] - cen) ** 2).sum(1).mean()))
    disp = np.linalg.norm(P[dyn, -1] - P[dyn, 0], axis=1)
    m = {"label": run["label"], "ms": R.get("ms"), "settle_s": None if settle is None else round(float(settle), 3),
         "max_pen_m": round(float(pen.max()), 4), "p95_pen_m": round(float(np.percentile(pen, 95)), 4),
         "max_floor_sink_m": round(float(floor.max()), 4),
         "spread_rms_m": round(spread, 3), "mean_disp_m": round(float(disp.mean()), 3), "max_disp_m": round(float(disp.max()), 3),
         "E0_J": round(float(E[0]), 2), "E_end_J": round(float(E[-1]), 2), "E_max_J": round(float(E.max()), 2)}
    series = {"t": t, "E": E, "pen": pen, "floor": floor, "P": P, "Q": Q, "V": V, "dyn": dyn, "ids": ids}
    name = sc["name"]
    if name == "s1_drop":
        y = P[dyn[0], :, 1]; rest = sc["bodies"][0]["size"][1] / 2
        h0 = y[0] - rest
        dy = np.diff(y)
        # first impact: the first frame whose forward step is no longer free fall (the step jumps up by > g dt^2 / 2)
        jump = np.where(np.diff(dy) > 0.5 * g * dt * dt)[0]
        fi = int(jump[0] + 1) if len(jump) else None
        ff = np.arange(F) * dt
        ff_err = float(np.abs(y[:fi] - (y[0] - 0.5 * g * ff[:fi] ** 2)).max()) if fi else None
        apex = float((y[fi:] - rest).max()) if fi else None
        m.update({"impact_frame": fi, "impact_frame_analytic": round(math.sqrt(2 * h0 / g) * FPS, 2),
                  "freefall_err_mm": None if ff_err is None else round(ff_err * 1000, 2),
                  "rebound_apex_m": None if apex is None else round(apex, 4),
                  "rebound_apex_expected_m": round(sc["bodies"][0]["restitution"] ** 2 * h0, 4),
                  "final_y_err_mm": round(float(y[-1] - rest) * 1000, 2)})
    if name == "s2_tower":
        tw = [k for k in dyn if ids[k].startswith("carton")]
        top = tw[-1]
        pre = slice(0, hit + 1)
        drift = np.linalg.norm(P[tw][:, pre][:, :, [0, 2]] - P[tw][:, :1, [0, 2]], axis=-1)
        tilt = []
        for k in tw:
            for f in range(hit + 1):
                up = rotmat(Q[k, f])[:, 1]; tilt.append(math.degrees(math.acos(max(-1, min(1, up[1])))))
        m.update({"pre_max_drift_m": round(float(drift.max()), 4), "pre_top_drift_m": round(float(drift[-1].max()), 4),
                  "pre_top_sag_m": round(float(P[top, 0, 1] - P[top, hit, 1]), 4), "pre_max_tilt_deg": round(max(tilt), 3),
                  "pre_max_pen_m": round(float(pen[pre].max()), 4),
                  "pre_E_gain_J": round(float((E[pre] - E[0]).max()), 2),
                  "fell": bool(P[top, -1, 1] < P[top, 0, 1] - 1.0),
                  "top_final_y_m": round(float(P[top, -1, 1]), 3),
                  "bottom_push_m": round(float(np.linalg.norm(P[tw[0], hit + 12, [0, 2]] - P[tw[0], hit, [0, 2]])), 3),
                  "hitter_travel_m": round(float(P[ids.index("hitter"), -1, 0] - P[ids.index("hitter"), hit, 0]), 3),
                  "hitter_speed_at_release": round(float(np.linalg.norm(P[ids.index("hitter"), hit] - P[ids.index("hitter"), hit - 1]) * FPS), 3)})
    if name == "s3_pyramid":
        m["crates_moved_gt_1m"] = int((disp > 1.0).sum())
        m["max_crate_speed"] = round(float(max(np.linalg.norm(V[k], axis=1).max() for k in dyn)), 2)
    if name == "s4_ramp":
        A = sc["analytic"]; d = np.array(A["downhill"]); n = np.array(A["normal"]); k = ids.index("slider")
        s = (P[k] - np.array(A["start"])) @ d
        off = (P[k] - np.array(A["start"])) @ n
        on = np.where(s < A["ramp_len"] - 0.3)[0]
        on = on[on > 0]
        ts, ss = t[on], s[on]
        a_fit = float((ss * 0.5 * ts ** 2).sum() / ((0.5 * ts ** 2) ** 2).sum()) if len(on) > 3 else None
        s_an = 0.5 * A["accel"] * ts ** 2
        mu_eff = None if a_fit is None else (math.sin(math.radians(30)) - a_fit / g) / math.cos(math.radians(30))
        m.update({"a_analytic": round(A["accel"], 4), "a_fit": None if a_fit is None else round(a_fit, 4),
                  "a_err_pct": None if a_fit is None else round(100 * (a_fit - A["accel"]) / A["accel"], 1),
                  "mu_effective": None if mu_eff is None else round(mu_eff, 4),
                  "s_rms_err_m": round(float(np.sqrt(((ss - s_an) ** 2).mean())), 4),
                  "t_2m_s": round(float(np.interp(2.0, s, t)), 3) if s.max() > 2 else None,
                  "t_2m_analytic_s": round(math.sqrt(2 * 2.0 / A["accel"]), 3),
                  "normal_off_max_mm": round(float(np.abs(off[on]).max() * 1000), 2) if len(on) else None})
        series["s"] = s; series["s_an"] = 0.5 * A["accel"] * t ** 2
    return m, series


results = {}
series = {}
for name, sc in scenes.items():
    results[name] = {}; series[name] = {}
    for run in runs:
        r = analyse(sc, run)
        if r is None: continue
        results[name][run["label"]], series[name][run["label"]] = r
# Cross-run final-position difference (each run vs the pair's reference, the second of --pair).
ref = pair[1] if len(pair) > 1 else labels[0]
for name in scenes:
    if ref not in series[name]: continue
    S0 = series[name][ref]
    for lb, S in series[name].items():
        d = np.linalg.norm(S["P"][S["dyn"], -1] - S0["P"][S0["dyn"], -1], axis=1)
        results[name][lb][f"final_vs_{ref}_mean_m"] = round(float(d.mean()), 3)
        n = min(len(S["t"]), len(S0["t"]))
        traj = np.linalg.norm(S["P"][S["dyn"], :n] - S0["P"][S0["dyn"], :n], axis=-1)
        results[name][lb][f"traj_vs_{ref}_rms_m"] = round(float(np.sqrt((traj ** 2).mean())), 3)

json.dump({"runs": [{"label": r["label"], "engine": r["engine"], "settings": r["settings"]} for r in runs], "metrics": results},
          open(os.path.join(outdir, "metrics.json"), "w"), indent=1)

# Tables.
lines = []
for name, sc in scenes.items():
    lines.append(f"\n### {name}: {sc['title']}\n")
    rs = results[name]
    keys = []
    for v in rs.values():
        for k in v:
            if k != "label" and k not in keys: keys.append(k)
    lines.append("| metric | " + " | ".join(rs) + " |")
    lines.append("|---|" + "---|" * len(rs))
    for k in keys:
        lines.append(f"| {k} | " + " | ".join(str(rs[l].get(k, "")) for l in rs) + " |")
open(os.path.join(outdir, "metrics.md"), "w").write("\n".join(lines) + "\n")
print("\n".join(lines))

# Charts.
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
plt.rcParams.update({"font.size": 9, "axes.spines.top": False, "axes.spines.right": False, "axes.grid": True, "grid.alpha": 0.25})
COL = {}
palette = ["#2a6fdb", "#e0782b", "#7a54c7", "#2f9e6e", "#c94a6a", "#8a8a8a", "#b8a020"]
for i, lb in enumerate(labels): COL[lb] = palette[i % len(palette)]
style = lambda lb: {"color": COL[lb], "lw": 1.6 if lb in pair else 1.0, "ls": "-" if lb in pair else "--", "label": lb}


def fig(name, fn, title, ylabel):
    f, ax = plt.subplots(figsize=(7, 3.4), dpi=130)
    fn(ax)
    ax.set_title(title, loc="left", fontsize=10); ax.set_xlabel("time (s)"); ax.set_ylabel(ylabel)
    ax.legend(frameon=False, fontsize=7)
    f.tight_layout(); f.savefig(os.path.join(outdir, name)); plt.close(f)


S = series
def drop_y(ax):
    for lb, s in S["s1_drop"].items(): ax.plot(s["t"], s["P"][s["dyn"][0], :, 1] - 0.4, **style(lb))
fig("s1_height.png", drop_y, "Drop: box bottom height", "height above floor (m)")

def tower_xy(ax):
    for lb, s in S["s2_tower"].items():
        ax.plot(s["t"], s["P"][s["dyn"][19], :, 1], **style(lb))
    ax.axvline(3.0, color="#999", lw=0.8)
fig("s2_top_height.png", tower_xy, "Tower: top carton height (hit at 3 s)", "y (m)")

def tower_bottom(ax):
    for lb, s in S["s2_tower"].items():
        ax.plot(s["t"], s["P"][s["ids"].index("hitter"), :, 0], **style(lb))
    ax.axvline(3.0, color="#999", lw=0.8)
fig("s2_hitter_x.png", tower_bottom, "Tower: 25 kg crate position", "x (m)")

def tower_drift(ax):
    for lb, s in S["s2_tower"].items():
        tw = s["dyn"][:20]
        d = np.linalg.norm(s["P"][tw][:, :, [0, 2]] - s["P"][tw][:, :1, [0, 2]], axis=-1).max(0)
        n = int(3.0 * FPS) + 1
        ax.plot(s["t"][:n], d[:n] * 1000, **style(lb))
fig("s2_pre_hit_drift.png", tower_drift, "Tower: worst carton drift before the hit", "mm")

def pyr(ax):
    for lb, s in S["s3_pyramid"].items():
        d = np.linalg.norm(s["P"][s["dyn"]] - s["P"][s["dyn"]][:, :1], axis=-1).mean(0)
        ax.plot(s["t"], d, **style(lb))
fig("s3_mean_disp.png", pyr, "Pyramid: mean crate displacement", "m")

def ramp(ax):
    first = True
    for lb, s in S["s4_ramp"].items():
        ax.plot(s["t"], s["s"], **style(lb))
        if first: ax.plot(s["t"], s["s_an"], color="#222", lw=1, ls=":", label="analytic g(sin - mu cos)"); first = False
    ax.set_ylim(0, scenes["s4_ramp"]["analytic"]["ramp_len"] + 0.5)
fig("s4_ramp_distance.png", ramp, "Ramp: distance slid vs analytic", "distance down ramp (m)")

f, axs = plt.subplots(2, 2, figsize=(9, 5.6), dpi=130)
for ax, name in zip(axs.flat, scenes):
    for lb, s in S[name].items(): ax.plot(s["t"], s["E"] - s["E"][0], **style(lb))
    ax.set_title(f"{name}: total energy - E(0)", loc="left", fontsize=9); ax.set_xlabel("s"); ax.set_ylabel("J")
axs[0, 0].legend(frameon=False, fontsize=7); f.tight_layout(); f.savefig(os.path.join(outdir, "energy.png")); plt.close(f)

f, axs = plt.subplots(2, 2, figsize=(9, 5.6), dpi=130)
for ax, name in zip(axs.flat, scenes):
    for lb, s in S[name].items(): ax.plot(s["t"], np.maximum(s["pen"], s["floor"]) * 1000, **style(lb))
    ax.set_title(f"{name}: deepest interpenetration", loc="left", fontsize=9); ax.set_xlabel("s"); ax.set_ylabel("mm")
axs[0, 0].legend(frameon=False, fontsize=7); f.tight_layout(); f.savefig(os.path.join(outdir, "penetration.png")); plt.close(f)

# Final rest positions, top view.
f, axs = plt.subplots(1, 2, figsize=(9, 3.8), dpi=130)
for ax, name in zip(axs, ["s2_tower", "s3_pyramid"]):
    for lb, s in S[name].items():
        p = s["P"][s["dyn"], -1]
        ax.scatter(p[:, 0], p[:, 2], s=14, color=COL[lb], label=lb, alpha=0.8, marker="o" if lb in pair else "x")
    ax.set_aspect("equal"); ax.set_title(f"{name}: final rest positions (top view)", loc="left", fontsize=9)
    ax.set_xlabel("x (m)"); ax.set_ylabel("z (m)")
axs[0].legend(frameon=False, fontsize=7); f.tight_layout(); f.savefig(os.path.join(outdir, "final_positions.png")); plt.close(f)
print("charts ->", outdir)
