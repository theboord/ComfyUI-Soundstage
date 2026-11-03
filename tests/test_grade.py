"""Colour pipeline tests (soundstage/grade, web/grade/grade.mjs), all on synthetic frames: OKLab and stats, the ASC
CDL, shot matching to a hero take, grade continuity ("1G is 0.4 stops warmer than 1H"), Steal the look, the
.cdl / .ccc / .cube writers, the NLE package and EDL *ASC_SOP lines, and byte-for-byte parity with the browser
writers (needs node).

Run:  python -m pytest tests/test_grade.py -q
"""
import base64
import io
import json
import os
import pathlib
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET

import numpy as np
import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from soundstage.cut import export_all  # noqa: E402
from soundstage.grade import cdl as C  # noqa: E402
from soundstage.grade.colour import frame_stats, linear_to_srgb, srgb_to_linear, srgb_to_oklab  # noqa: E402
from soundstage.grade.continuity import check_cut, compare  # noqa: E402
from soundstage.grade.package import grade_files  # noqa: E402
from soundstage.grade.steal import STOCK_PROFILES, grain_estimate, neutralise, steal_look  # noqa: E402

NODE = shutil.which("node")
NS = "{urn:ASC:CDL:v1.01}"


# ------------------------------------------------------------------------------------------- synthetic frames

def scene(h=180, w=320, seed=0, shift=0.0):
    """A 'set': sky gradient, a warm wall, a grey floor, a skin-ish patch and a dark doorway. `shift` slides the
    framing (another setup of the same scene sees a different part of it)."""
    rng = np.random.default_rng(seed)
    y, x = np.mgrid[0:h, 0:w].astype(float)
    x = x / w + shift
    img = np.zeros((h, w, 3))
    sky = y < h * 0.35
    img[sky] = np.stack([0.45 + 0.1 * x, 0.6 + 0.1 * x, 0.85 + 0 * x], -1)[sky]
    wall = (~sky) & (y < h * 0.7)
    img[wall] = np.stack([0.7 + 0.1 * np.sin(6 * x), 0.5 + 0 * x, 0.35 + 0 * x], -1)[wall]
    floor = y >= h * 0.7
    img[floor] = np.stack([0.42 + 0.05 * x, 0.42 + 0.05 * x, 0.42 + 0.05 * x], -1)[floor]
    cx = (0.5 - shift) * w
    face = (np.hypot(np.arange(w)[None, :] - cx, np.arange(h)[:, None] - h * 0.5) < h * 0.12)
    img[face] = [0.85, 0.62, 0.5]
    img *= (0.35 + 0.75 * np.sin(np.pi * (x - shift + 0.1) / 1.2) ** 2)[..., None] * (1.05 - 0.6 * (y / h) ** 2)[..., None]   # light fall-off
    door = (np.abs(np.arange(w)[None, :] - (0.8 - shift) * w) < w * 0.06) & (y > h * 0.3) & (y < h * 0.7)
    img[door] = [0.06, 0.05, 0.05]
    return np.clip(img + rng.normal(0, 0.01, img.shape), 0, 1)


def warm(img, stops):
    """Warm by `stops` (log2 R/B) in linear light, keeping luminance roughly put."""
    lin = srgb_to_linear(img) * np.array([2 ** (stops / 2), 1.0, 2 ** (-stops / 2)])
    return linear_to_srgb(lin)


def expose(img, stops):
    return linear_to_srgb(srgb_to_linear(img) * 2 ** stops)


def data_url(img):
    from PIL import Image
    buf = io.BytesIO()
    Image.fromarray((np.clip(img, 0, 1) * 255).round().astype(np.uint8)).save(buf, "PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


# ------------------------------------------------------------------------------------------- colour + stats

def test_oklab_white_and_grey():
    lab = srgb_to_oklab(np.array([[1.0, 1.0, 1.0], [0.5, 0.5, 0.5]]))
    assert abs(lab[0, 0] - 1) < 1e-3 and np.abs(lab[:, 1:]).max() < 1e-3
    assert np.allclose(linear_to_srgb(srgb_to_linear([0.2, 0.5, 0.9])), [0.2, 0.5, 0.9])


def test_stats_measure_warmth_and_exposure_in_stops():
    base = scene()
    a, b = frame_stats(base), frame_stats(warm(base, 0.4))
    assert abs((b["warmth_ev"] - a["warmth_ev"]) - 0.4) < 0.08
    c = frame_stats(expose(base, -0.5))
    assert abs((c["exposure_ev"] - a["exposure_ev"]) + 0.5) < 0.12


# ------------------------------------------------------------------------------------------- CDL

def test_cdl_identity_and_known_values():
    img = scene()
    assert np.allclose(C.apply_cdl(img, C.IDENTITY), img)
    px = C.apply_cdl(np.array([[0.5, 0.5, 0.5]]), {"slope": 1.2, "offset": -0.1, "power": 2, "sat": 1})
    assert np.allclose(px, 0.25)
    grey = C.apply_cdl(np.array([[0.8, 0.2, 0.4]]), {"sat": 0})
    assert np.allclose(grey, grey[0, 0])
    n = C.normalize_cdl({"slope": [9, "x"], "sat": -3})
    assert n["slope"] == [4.0, 1.0, 1.0] and n["sat"] == 0.0 and C.is_identity(None)


def test_fit_cdl_matches_a_take_to_the_hero():
    hero = scene()
    off = C.apply_cdl(warm(hero, -0.5), {"slope": [1.1, 1.0, 0.95], "offset": 0.03, "power": 1.1, "sat": 0.75})
    r = C.fit_cdl(off, hero)
    assert r["error_after"] < 0.25 * r["error_before"]
    got, want = frame_stats(C.apply_cdl(off, r["cdl"])), frame_stats(hero)
    d = compare(got, want)
    assert abs(d["warmth_ev"]) < 0.15 and abs(d["exposure_ev"]) < 0.15 and d["delta_e"] < 1.5


def test_fit_cdl_across_coverage_of_one_scene():
    """The take frames another part of the set (and a different cast) but is matched on perceptual statistics."""
    hero, take = scene(seed=1), warm(expose(scene(seed=2, shift=0.15), 0.4), 0.45)
    before = compare(frame_stats(take), frame_stats(hero))
    r = C.fit_cdl(take, hero)
    after = compare(frame_stats(C.apply_cdl(take, r["cdl"])), frame_stats(hero))
    assert abs(after["warmth_ev"]) < abs(before["warmth_ev"]) / 2
    assert abs(after["exposure_ev"]) < abs(before["exposure_ev"]) / 2


def test_fit_cdl_leaves_a_matching_take_alone():
    hero = scene()
    r = C.fit_cdl(hero, hero)
    assert r["error_after"] <= r["error_before"] + 1e-9
    c = r["cdl"]
    assert max(abs(v - 1) for v in c["slope"] + c["power"]) < 0.05 and max(abs(v) for v in c["offset"]) < 0.02


# ------------------------------------------------------------------------------------------- continuity

def test_continuity_flags_a_warmer_shot_in_stops():
    a = frame_stats(scene())
    b = frame_stats(warm(scene(), 0.4))
    rows = [{"id": "h", "name": "1H", "scene": "SC1", "stats": a}, {"id": "g", "name": "1G", "scene": "SC1", "stats": b}]
    flags = check_cut(rows)
    assert len(flags) == 1 and flags[0]["key"] == "warmth_ev"
    assert flags[0]["text"].startswith("1G is 0.4 stops warmer than 1H"), flags[0]["text"]
    assert check_cut([rows[0], {**rows[1], "scene": "SC2"}]) == []        # a cut between scenes is not judged
    dark = {"id": "d", "name": "1D", "scene": "SC1", "stats": frame_stats(expose(scene(), -1.0))}
    assert "1D is 1.0 stop darker than 1H" in check_cut([rows[0], dark])[0]["text"]
    assert check_cut([rows[0], {**rows[0], "id": "x"}]) == []


# ------------------------------------------------------------------------------------------- steal the look

def _vocab_stocks():
    from soundstage.look.vocab import options
    return {o["id"] for o in options("film_stock")} - {"auto"}


def test_stock_profiles_cover_the_vocabulary():
    assert set(STOCK_PROFILES) == _vocab_stocks()


def test_steal_bleach_bypass_reference():
    ref = scene()
    y = (ref @ np.array([0.2126, 0.7152, 0.0722]))[..., None]
    ref = np.clip(y + 0.25 * (ref - y), 0, 1)                    # desaturated
    ref = np.clip((ref - 0.5) * 1.7 + 0.5, 0, 1)                 # hard contrast
    r = steal_look(ref)
    ids = [r["stock"]["id"]] + [a["id"] for a in r["alternatives"]]
    assert "bleach_bypass" in ids, ids
    p = r["look_patch"]
    assert p["grade"]["contrast"] > 0.3 and p["grade"]["saturation"] < -0.3
    assert len(p["colour"]["curve"]) == 17 and p["colour"]["curve"] == sorted(p["colour"]["curve"])


def test_steal_black_and_white_reference_drops_the_palette():
    g = scene() @ np.array([0.2126, 0.7152, 0.0722])
    r = steal_look(np.repeat(g[..., None], 3, axis=2))
    assert STOCK_PROFILES[r["stock"]["id"]][6] is True
    assert "palette" not in r["look_patch"] and r["palette"] == []


def test_steal_warm_reference_palette_and_grade_reproduce_it():
    ref = warm(scene(), 0.6)
    r = steal_look(ref)
    assert r["look_patch"]["grade"]["warmth"] > 0.3
    sw = r["look_patch"]["palette"]["swatches"]
    assert len(sw) == 5 and all(s.startswith("#") and len(s) == 7 for s in sw)
    neutral = neutralise(ref)
    graded = C.apply_cdl(neutral, r["cdl"])
    want = frame_stats(ref)
    assert compare(frame_stats(graded), want)["delta_e"] < compare(frame_stats(neutral), want)["delta_e"]


def test_grain_estimate_sees_grain():
    clean = scene()
    rng = np.random.default_rng(5)
    noisy = np.clip(clean + rng.normal(0, 0.05, clean.shape), 0, 1)
    assert grain_estimate(noisy) > grain_estimate(clean) + 0.3


def test_steal_patch_is_a_valid_look():
    from soundstage.look.vocab import normalize_look
    r = steal_look(warm(scene(), 0.3))
    look, notes = normalize_look(r["look_patch"])
    assert look["film_stock"] == r["stock"]["id"] and not notes
    assert look["colour"]["curve"] == r["curve"] and look["palette"]["preset"] == "custom"


# ------------------------------------------------------------------------------------------- writers

GRADE = {"slope": [1.1, 1.0, 0.9], "offset": [0.01, 0.0, -0.02], "power": [0.95, 1.0, 1.05], "sat": 0.85}


def test_cdl_and_ccc_xml():
    root = ET.fromstring(C.cdl_xml("Sc_1_1G", GRADE, "matched to 1H"))
    cc = root.find(f"{NS}ColorDecision/{NS}ColorCorrection")
    assert cc.get("id") == "Sc_1_1G"
    assert cc.find(f"{NS}SOPNode/{NS}Slope").text == "1.1000 1.0000 0.9000"
    assert cc.find(f"{NS}SOPNode/{NS}Offset").text == "0.0100 0.0000 -0.0200"
    assert cc.find(f"{NS}SATNode/{NS}Saturation").text == "0.8500"
    ccc = ET.fromstring(C.ccc_xml([{"id": "a", "cdl": GRADE}, {"id": "b", "cdl": C.IDENTITY}]))
    assert [x.get("id") for x in ccc.findall(f"{NS}ColorCorrection")] == ["a", "b"]
    assert C.edl_sop(GRADE) == ["*ASC_SOP (1.1000 1.0000 0.9000)(0.0100 0.0000 -0.0200)(0.9500 1.0000 1.0500)", "*ASC_SAT 0.8500"]


def test_cube_is_33_cubed_and_bakes_the_cdl():
    text = C.cube_text(GRADE)
    assert "LUT_3D_SIZE 33" in text
    size, table = C.parse_cube(text)
    assert size == 33 and table.shape == (33 ** 3, 3)
    size_i, ident = C.parse_cube(C.cube_text())
    grid = np.stack(np.meshgrid(*[np.linspace(0, 1, 33)] * 3, indexing="ij"), -1)[..., ::-1].reshape(-1, 3)  # R fastest
    assert np.allclose(ident, grid, atol=1e-6)
    img = scene()
    q = np.rint(img * 32) / 32                                   # on the lattice: the bake equals the CDL
    assert np.abs(C.apply_cube(q, size, table) - C.apply_cdl(q, GRADE)).max() < 2e-6
    curve = [min(1, i / 16 * 1.1) for i in range(17)]
    _, t2 = C.parse_cube(C.cube_text([GRADE, {"sat": 1.2}], curve))
    assert not np.allclose(t2, table)


def test_fixed_rounds_like_javascript():
    assert C._f4(0.03125) == "0.0313" and C._f4(-0.00001) == "0.0000" and C._f6(1) == "1.000000"


# ------------------------------------------------------------------------------------------- NLE package

GRADED = {
    "name": "Last Light", "fps": 24,
    "shots": [
        {"id": "h", "name": "Sc 1 · 1H", "frames": 48, "scene_name": "SC1", "renders": {"final": "/view?filename=h.mp4&type=output"}},
        {"id": "g", "name": "Sc 1 · 1G", "frames": 48, "scene_name": "SC1", "renders": {"final": "/view?filename=g.mp4&type=output"},
         "grade": {**GRADE, "note": "matched to Sc 1 · 1H"}},
        {"id": "k", "name": "Sc 1 · 1K", "frames": 24, "scene_name": "SC1", "renders": {"draft": "/view?filename=k.mp4&type=output"},
         "grade": dict(C.IDENTITY)},
    ],
    "cut": [{"shot_id": "h", "in": 0, "out": 48}, {"shot_id": "g", "in": 0, "out": 48}, {"shot_id": "k", "in": 0, "out": 24}],
    "colour": {"show": {"cdl": {"slope": [1.02, 1.0, 0.97], "sat": 0.9}, "curve": [i / 16 for i in range(17)], "name": "Stolen from ref"}},
}


def test_package_files_and_edl_sop():
    files = export_all(GRADED)
    for k in ["Last_Light_grades.ccc", "Last_Light_Sc_1_1G.cdl", "Last_Light_Sc_1_1G.cube", "Last_Light_show.cdl",
              "Last_Light_show.cube", "GRADE.txt"]:
        assert k in files, k
    assert not any("1K" in k or "1H" in k for k in files if k.endswith((".cdl", ".cube")))   # identity / hero: no file
    edl = files["Last_Light.edl"]
    i = edl.index("* FROM CLIP NAME: Sc 1 · 1G")
    assert "*ASC_SOP (1.1000 1.0000 0.9000)" in edl[i:i + 400] and edl.count("*ASC_SOP") == 1
    assert "Use CDL from EDL" in files["GRADE.txt"]


def test_package_unchanged_without_grades():
    plain = {**GRADED, "shots": [{k: v for k, v in s.items() if k != "grade"} for s in GRADED["shots"]]}
    plain.pop("colour")
    files = export_all(plain)
    assert not any(k.endswith((".ccc", ".cdl", ".cube")) or k == "GRADE.txt" for k in files)
    assert "*ASC_SOP" not in files["Last_Light.edl"]
    from soundstage.cut.export import normalize_project
    assert grade_files(normalize_project(plain), "x") == {}


# ------------------------------------------------------------------------------------------- routes (no server)

def test_route_functions_on_data_urls():
    from soundstage.grade import routes as R
    hero, take = scene(), warm(scene(seed=3, shift=0.1), 0.5)
    st = R.stats({"frames": [{"id": "h", "image": data_url(hero)}, {"id": "t", "image": data_url(take), "cdl": GRADE},
                             {"id": "bad", "url": "/view?filename=nope.png&type=output"}]})
    assert set(st["stats"]) == {"h", "t"} and "graded" in st["stats"]["t"] and "bad" in st["errors"]
    m = R.match({"hero": {"id": "h", "image": data_url(hero)}, "takes": [{"id": "h", "image": data_url(hero)}, {"id": "t", "image": data_url(take)}]})
    assert list(m["grades"]) == ["t"] and m["grades"]["t"]["error_after"] < m["grades"]["t"]["error_before"]
    s = R.steal({"image": data_url(warm(scene(), 0.4))})
    assert s["stock"]["label"] and s["look_patch"]["colour"]["cdl"]
    flags = R.continuity({"shots": [{"id": "h", "name": "1H", "stats": st["stats"]["h"]},
                                    {"id": "t", "name": "1T", "stats": st["stats"]["t"]}]})["flags"]
    assert isinstance(flags, list)


# ------------------------------------------------------------------------------------------- browser parity

def _node(script, arg):
    res = subprocess.run([NODE, "--input-type=module", "-e", script, json.dumps(arg)], capture_output=True, text=True, check=True)
    return json.loads(res.stdout)


@pytest.mark.skipif(not NODE, reason="node not installed")
def test_package_parity_with_browser_writers():
    mod = pathlib.Path(ROOT, "web", "cut", "exporters.mjs").as_uri()
    js = _node(f'import {{ exportAll }} from "{mod}"; process.stdout.write(JSON.stringify(exportAll(JSON.parse(process.argv[1]))));', GRADED)
    py = export_all(GRADED)
    assert list(js) == list(py)
    for name in py:
        assert js[name] == py[name], name


@pytest.mark.skipif(not NODE, reason="node not installed")
def test_continuity_parity_with_coach():
    base = scene()
    rows = [{"id": "a", "name": "1A", "scene": "SC1", "stats": frame_stats(base)},
            {"id": "b", "name": "1B", "scene": "SC1", "stats": frame_stats(warm(base, 0.25))},
            {"id": "c", "name": "1C", "scene": "SC1", "stats": frame_stats(expose(warm(base, -0.3), 0.6))},
            {"id": "d", "name": "1D", "scene": "SC2", "stats": frame_stats(expose(base, -2))},
            {"id": "e", "name": "1E", "scene": "SC2", "stats": frame_stats(base)}]
    mod = pathlib.Path(ROOT, "web", "grade", "grade.mjs").as_uri()
    js = _node(f'import {{ checkCut }} from "{mod}"; process.stdout.write(JSON.stringify(checkCut(JSON.parse(process.argv[1]))));', rows)
    py = check_cut(rows)
    assert len(py) >= 2
    assert [(f["a"], f["b"], f["key"], f["text"]) for f in js] == [(f["a"], f["b"], f["key"], f["text"]) for f in py]


def test_routes_register_on_a_route_table():
    web = pytest.importorskip("aiohttp.web")
    from soundstage.grade import routes as R
    table = web.RouteTableDef()
    R._REGISTERED = False
    assert R.register(table)
    assert sorted(r.path for r in table) == [f"/soundstage/grade/{n}" for n in ("continuity", "match", "stats", "steal")]
    R._REGISTERED = False
