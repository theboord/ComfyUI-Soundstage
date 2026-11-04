"""Milestone 18: Draft · Final · Advanced presets, the Advanced (LTX) settings mapping (steps, shift, scheduler…),
the retired Hollywood preset's migration and the App wiring."""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tools" / "app_build"))

from soundstage import ltx_settings as L  # noqa: E402
from soundstage import quality as Q  # noqa: E402

FULL = ROOT / "example_workflows" / "Soundstage_App_Full.json"
parse = lambda s: [float(x) for x in s.split(",")]  # noqa: E731


def test_presets_file_has_the_three_presets():
    p = L.load_presets()
    assert list(p) == ["Draft", "Final", "Advanced"] and "Hollywood" not in p
    for name, s in p.items():
        r = L.resolve({"preset": name})
        assert r["preset"] == name and r["two_stage"] is True and r["cfg"] == 1.0
        assert r["scheduler"] == "distilled" and r["shift"] == 1.0
    # Final works harder than Draft; Advanced starts from Final's numbers (every knob is then the user's).
    d, f, a = (L.resolve({"preset": n}) for n in ("Draft", "Final", "Advanced"))
    assert d["steps_1"] < f["steps_1"] and d["steps_2"] < f["steps_2"] and f["crf"] < d["crf"]
    keys = ("resolution", "two_stage", "steps_1", "steps_2", "s2_start", "sampler", "cfg", "temporal_x2", "decode", "codec", "crf")
    assert {k: a[k] for k in keys} == {k: f[k] for k in keys}
    assert a["from"] == "Final" and "from" not in f


def test_the_retired_hollywood_preset_loads_as_advanced_with_its_values():
    """A shot saved on Hollywood (1408p, 12 + 6 steps, CRF 12) keeps rendering that way, as an Advanced shot."""
    h = L.resolve({"preset": "Hollywood"})
    assert h["preset"] == "Advanced" and h["from"] == "Final"
    assert (h["resolution"], h["steps_1"], h["steps_2"], h["crf"]) == (1408, 12, 6, 12)
    assert L.resolve({"preset": "Hollywood", "codec": "prores_hq", "steps_1": 14})["steps_1"] == 14   # its overrides still win
    assert L.resolve({"preset": "Hollywood", "codec": "prores_hq"})["codec"] == "prores_hq"
    # the Quality node's combo on an old saved workflow, and an old advanced JSON naming it
    assert L.from_quality("Hollywood", "")["resolution"] == 1408
    assert L.from_quality("Draft", '{"preset":"Hollywood"}')["preset"] == "Advanced"
    assert L.legacy_presets()["Hollywood"]["resolution"] == 1408
    assert L.stage_sizes(960, 512, h)["output"][1] == 1408
    assert L.estimate_seconds(h, 960, 512, 121) > L.estimate_seconds(L.resolve({"preset": "Final"}), 960, 512, 121)


def test_shift_and_scheduler_reach_the_graphs_sigmas():
    """The graph samples on ManualSigmas strings from the Quality node, so shift and the scheduler are applied to the
    schedule itself (the same curve as ModelSamplingLTXV / LTXVScheduler's shift)."""
    final = L.resolve({"preset": "Final"})
    s1, s2 = L.schedules(final)
    assert L.schedules(L.resolve({"preset": "Advanced"})) == (s1, s2), "Advanced starts as Final, bit for bit"
    assert L.schedules(L.resolve({"preset": "Advanced", "shift": 1.0, "scheduler": "distilled"})) == (s1, s2)
    up = parse(L.schedules(L.resolve({"preset": "Advanced", "shift": 2.0}))[0])
    assert len(up) == len(parse(s1)) and up[0] == 1.0 and up[-1] == 0.0 and up == sorted(up, reverse=True)
    assert all(a >= b for a, b in zip(up[1:-1], parse(s1)[1:-1])), "shift above 1 keeps the sigmas higher (more composition steps)"
    down = parse(L.schedules(L.resolve({"preset": "Advanced", "shift": 0.5}))[0])
    assert all(a <= b for a, b in zip(down[1:-1], parse(s1)[1:-1]))
    t2 = parse(L.schedules(L.resolve({"preset": "Advanced", "shift": 2.0}))[1])
    assert abs(t2[0] - 0.909375) < 1e-6 and t2[-1] == 0.0, "stage 2 keeps its start sigma"
    lin = parse(L.schedules(L.resolve({"preset": "Advanced", "scheduler": "linear", "steps_1": 5, "steps_2": 2}))[0])
    assert lin == [1.0, 0.8, 0.6, 0.4, 0.2, 0.0]
    lq = parse(L.schedules(L.resolve({"preset": "Advanced", "scheduler": "linear_quadratic", "steps_1": 10}))[0])
    assert len(lq) == 11 and lq[0] == 1.0 and lq[-1] == 0.0 and lq == sorted(lq, reverse=True)
    assert lq[1] > 0.99 and (lq[-2] - lq[-1]) > (lq[0] - lq[1]), "tiny linear steps near 1.0, quadratic growth toward 0"
    assert L.resolve({"scheduler": "bogus", "shift": 0})["scheduler"] == "distilled"
    assert L.resolve({"scheduler": "bogus", "shift": 0})["shift"] == 1.0
    assert L.resolve({"shift": 99})["shift"] == 10.0
    # manual sigmas still win over everything
    assert L.schedules(L.resolve({"scheduler": "linear", "shift": 3, "sigmas_1": "1.0, 0.5, 0.0"}))[0] == "1.0, 0.5, 0.0"


def test_fewer_than_8_steps_thins_the_distilled_curve():
    for n in (1, 2, 4, 6):
        s = parse(L.sigmas_1(n))
        assert len(s) == n + 1 and s[0] == 1.0 and s[-1] == 0.0 and s == sorted(s, reverse=True)
        assert set(s) <= set(L.DISTILLED_1), "only the tuned knots, fewer of them"
    assert L.resolve({"steps_1": 0})["steps_1"] == L.MIN_STEPS_1 == 1


def test_default_is_final_not_draft():
    """The leak Mike saw: finals were rendered at Draft because the App's quality started on Draft."""
    assert L.resolve({})["preset"] == "Final"
    assert L.resolve({"preset": "nonsense"})["preset"] == "Final"


def test_preset_schedules_are_the_apps_tuned_ones_bit_for_bit():
    assert L.schedules(L.resolve({"preset": "Draft"})) == (Q.DRAFT_SIGMAS_1, Q.DRAFT_SIGMAS_2)
    assert L.schedules(L.resolve({"preset": "Final"})) == (Q.FINAL_SIGMAS_1, Q.FINAL_SIGMAS_2)
    assert L.sigmas_1(18) == Q.HQ_SIGMAS_1 and L.sigmas_2(12) == Q.HQ_SIGMAS_2


def test_any_step_count_keeps_the_distilled_curve():
    for n in (9, 10, 14, 24, 30):
        s = parse(L.sigmas_1(n))
        assert len(s) == n + 1 and s[0] == 1.0 and s[-1] == 0.0 and s == sorted(s, reverse=True)
        assert set(L.DISTILLED_1) <= {round(x, 7) for x in s} | {1.0, 0.0}   # every tuned knot is kept
    for n, start in ((3, 0.85), (5, 0.85), (8, 0.909375), (4, 0.6)):
        s = parse(L.sigmas_2(n, start))
        assert len(s) == n + 1 and abs(s[0] - start) < 1e-6 and s[-1] == 0.0 and s == sorted(s, reverse=True)
    assert parse(L.sigmas_2(3, 0.85)) == [0.85, 0.725, 0.421875, 0.0]   # Lightricks' LTX-2.5 two-stage default


def test_manual_sigmas_override_steps():
    s = L.resolve({"preset": "Final", "sigmas_1": "1.0, 0.5, 0.0", "sigmas_2": "0.5, 0.0"})
    assert L.schedules(s) == ("1.0, 0.5, 0.0", "0.5, 0.0")


def test_overrides_and_clamps():
    s = L.resolve({"preset": "Draft", "resolution": 99999, "steps_1": 0, "cfg": 0, "crf": 99, "codec": "gif", "sampler": "x",
                   "seed": 7, "ic_lora": 3, "fps": 1000})
    assert s["resolution"] == 2176 and s["steps_1"] == 1 and s["cfg"] == 1.0 and s["crf"] == 51
    assert s["codec"] == "h264" and s["sampler"] == "euler_ancestral" and s["seed"] == 7 and s["ic_lora"] == 2.0 and s["fps"] == 60.0
    assert L.resolve('{"preset":"Advanced","codec":"prores_hq"}')["codec"] == "prores_hq"
    assert L.resolve("not json")["preset"] == "Final"


def test_quality_combo_maps_to_presets_and_advanced_wins():
    assert L.from_quality("Draft", "")["preset"] == "Draft"
    hq = L.from_quality("Final HQ", "")
    assert (hq["preset"], hq["steps_1"], hq["steps_2"]) == ("Final", 18, 12)
    assert L.from_quality("Draft", '{"preset":"Advanced"}')["preset"] == "Advanced"
    assert L.from_quality("Draft", '{"steps_1": 10}')["steps_1"] == 10      # no preset named: the combo's preset + override
    assert L.from_quality("Draft", '{"steps_1": 10}')["preset"] == "Draft"


def test_stage_sizes_match_todays_final_and_scale():
    # The clay guide is 960x512: today's App renders stage 1 at 992x544 and the final at 1984x1088.
    final = L.stage_sizes(960, 512, L.resolve({"preset": "Final"}))
    assert final == {"stage1": (992, 544), "output": (1984, 1088)}
    one = L.stage_sizes(960, 512, L.resolve({"preset": "Final", "two_stage": False}))
    assert one["stage1"] == one["output"] and one["output"][1] == 1088
    hw = L.stage_sizes(960, 512, L.resolve({"preset": "Advanced", "resolution": 1408}))
    for k in ("stage1", "output"):
        assert all(v % 32 == 0 for v in hw[k])
    assert hw["output"][1] > 1088


def test_time_estimate_orders_the_presets():
    t = [L.estimate_seconds(L.resolve(n), 960, 512, 121) for n in ({"preset": "Draft"}, {"preset": "Final"}, {"preset": "Advanced", "resolution": 1408})]
    assert t[0] < t[1] < t[2]
    assert L.estimate_seconds(L.resolve({"preset": "Advanced", "steps_1": 4, "steps_2": 1}), 960, 512, 121) < t[0], "fewer steps, a faster draft"
    s = L.resolve({"preset": "Final"})
    assert L.estimate_seconds({**s, "cfg": 2.0}, 960, 512, 121) > t[1]
    assert L.estimate_seconds({**s, "temporal_x2": True}, 960, 512, 121) > t[1]


# ------------------------------------------------------------------------------------------------ App wiring
def _full():
    wf = json.loads(FULL.read_text())
    nodes = {n["id"]: n for n in wf["nodes"]}
    links = {l[0]: l for l in wf["links"]}
    return wf, nodes, links


def _src(nodes, links, nid, name):
    inp = next(i for i in nodes[nid]["inputs"] if i["name"] == name)
    l = links[inp["link"]]
    return l[1], nodes[l[1]]["outputs"][l[2]]["name"]


def test_app_quality_node_drives_the_render():
    wf, nodes, links = _full()
    q = next(i for i, n in nodes.items() if n["type"] == "SoundstageQuality")
    assert nodes[q]["widgets_values"][1] == "Final" and json.loads(nodes[q]["widgets_values"][2]) == {"preset": "Final"}
    assert _src(nodes, links, q, "guide") == (9045, "clay")                       # the full-size clay, resized by Quality
    size = _src(nodes, links, 9002, "width")[0]
    assert nodes[size]["type"] == "GetImageSize" and _src(nodes, links, size, "image") == (q, "out_guide")
    assert _src(nodes, links, 9002, "length")[0] == size
    for nid in (5516, 9034):
        assert _src(nodes, links, nid, "cfg") == (q, "cfg")
        assert _src(nodes, links, nid, "noise_seed") == (q, "seed")               # the same seed in both stages
    assert _src(nodes, links, 5518, "fps") == (q, "fps_final")
    assert _src(nodes, links, 9002, "fps") == (q, "fps_out")
    for k in ("tile_size", "overlap", "temporal_size", "temporal_overlap"):
        assert _src(nodes, links, 5518, k) == (q, k)


def test_app_final_latent_switches_and_saves():
    wf, nodes, links = _full()
    q = next(i for i, n in nodes.items() if n["type"] == "SoundstageQuality")
    tsel = _src(nodes, links, 5518, "latents")[0]
    assert nodes[tsel]["type"] == "ComfySwitchNode" and _src(nodes, links, tsel, "switch") == (q, "temporal_x2")
    ssel = _src(nodes, links, tsel, "on_false")[0]
    assert _src(nodes, links, ssel, "switch") == (q, "two_stage")
    assert _src(nodes, links, ssel, "on_true")[0] == 9034 and _src(nodes, links, ssel, "on_false")[0] == 5516
    up = _src(nodes, links, tsel, "on_true")[0]
    assert nodes[up]["type"] == "LTXVLatentUpsampler"
    loader = _src(nodes, links, up, "upscale_model")[0]
    assert "temporal" in nodes[loader]["widgets_values"][0]
    # the extra LoRA sits between the model loader and both samplers
    for nid in (5516, 9034):
        lora = _src(nodes, links, nid, "model")[0]
        assert nodes[lora]["type"] == "SoundstageLTXLoRA" and _src(nodes, links, lora, "model")[0] == 5004
    # every Rung 4 final saves through Soundstage · Save Final with the shot's settings
    saves = [n for n in nodes.values() if (n.get("title") or "").startswith("Rung 4")]
    assert saves and all(n["type"] == "SoundstageSaveVideo" for n in saves)
    for n in saves:
        assert _src(nodes, links, n["id"], "settings_json") == (q, "settings_json")
    # node ids the JS and saved projects rely on did not move
    assert nodes[9097]["title"].startswith("Rung 5 · Layer Pack folder") and nodes[9099]["title"].startswith("Rung 1 · Previz")


def test_builder_reproduces_the_committed_app():
    import importlib
    from graph import Graph
    import build
    g = Graph.load(ROOT / "example_workflows" / "Soundstage_App.json")
    for name in build.PARTS:
        importlib.import_module(name).apply(g)
    _, nodes, links = _full()
    built = {n["id"]: (n["type"], n.get("title"), json.dumps(n.get("widgets_values"))) for n in g.w["nodes"]}
    assert built == {i: (n["type"], n.get("title"), json.dumps(n.get("widgets_values"))) for i, n in nodes.items()}
    assert sorted(tuple(l[1:5]) for l in g.w["links"]) == sorted(tuple(l[1:5]) for l in links.values())


# ---------------------------------------------------------------- Adherence (share/Blocking_Adherence/REPORT.txt)

def test_adherence_levels_and_default():
    t = L.load_adherence()
    assert list(t["levels"]) == list(L.ADHERENCE_NAMES) == ["Loose", "Balanced", "Exact"]
    assert t["default"] == "Exact"
    # Every preset (and an empty or old shot) renders at Exact unless the shot says otherwise.
    for name in L.PRESET_NAMES:
        assert L.resolve({"preset": name})["adherence"] == "Exact"
    assert L.resolve({"adherence": "nonsense"})["adherence"] == "Exact"
    assert L.from_quality("Final", "")["adherence"] == "Exact"


def test_adherence_maps_to_the_tested_knobs():
    k = {n: L.adherence_knobs(L.resolve({"adherence": n})) for n in L.ADHERENCE_NAMES}
    assert k["Exact"] == {"adherence": "Exact", "motion_freedom": 0.0, "ic_lora": 1.0, "guide_blur": 0, "reference": 0.5}
    assert k["Loose"]["guide_blur"] == 10 and k["Loose"]["ic_lora"] == 0.825 and k["Loose"]["reference"] == 1.0
    # Tighter = sharper guide, stronger IC-LoRA, lighter look reference.
    order = [k[n] for n in ("Loose", "Balanced", "Exact")]
    assert [x["guide_blur"] for x in order] == sorted([x["guide_blur"] for x in order], reverse=True)
    assert [x["ic_lora"] for x in order] == sorted(x["ic_lora"] for x in order)
    assert [x["reference"] for x in order] == sorted([x["reference"] for x in order], reverse=True)
    # The clay look appears below ~0.4 reference (REPORT): no level goes there.
    assert min(x["reference"] for x in order) >= 0.4


def test_raw_values_override_adherence_and_clamp():
    k = L.adherence_knobs(L.resolve({"adherence": "Loose", "ic_lora": 1.3, "guide_blur": 99, "reference": -1}))
    assert k["adherence"] == "Loose" and k["ic_lora"] == 1.3 and k["guide_blur"] == 32 and k["reference"] == 0.0
    assert L.adherence_knobs(L.resolve({"adherence": "Exact", "reference": 0.8}))["reference"] == 0.8


def _l2r_prompt(advanced="", quality="Final", strength=1.0):
    return {"9096": {"class_type": "SoundstageQuality", "inputs": {"quality": quality, "advanced": advanced, "motion_freedom": 0.5}},
            "9002:5012": {"class_type": "LTXAddVideoICLoRAGuide", "inputs": {"frame_idx": 0, "strength": ["9096", 1]}},
            "9002:9042": {"class_type": "LTXAddVideoICLoRAGuide", "inputs": {"frame_idx": -1, "strength": strength}},
            "9034:9043": {"class_type": "LTXAddVideoICLoRAGuide", "inputs": {"frame_idx": -1, "strength": strength}}}


def test_reference_strength_is_set_on_the_prompt():
    p = L.apply_reference(_l2r_prompt())                                  # an old shot: no adherence -> Exact
    assert p["9002:9042"]["inputs"]["strength"] == 0.5 and p["9034:9043"]["inputs"]["strength"] == 0.5
    assert p["9002:5012"]["inputs"]["strength"] == ["9096", 1]           # the clay guide is not touched
    p = L.apply_reference(_l2r_prompt(json.dumps({"preset": "Final", "adherence": "Loose"})))
    assert p["9002:9042"]["inputs"]["strength"] == 1.0
    p = L.apply_reference(_l2r_prompt(json.dumps({"preset": "Hollywood", "reference": 0.7})))
    assert p["9034:9043"]["inputs"]["strength"] == 0.7
    p = L.apply_reference(_l2r_prompt(strength=["1", 0]))                # a linked strength is left alone
    assert p["9002:9042"]["inputs"]["strength"] == ["1", 0]
    other = {"1": {"class_type": "LTXAddVideoICLoRAGuide", "inputs": {"frame_idx": -1, "strength": 1.0}}}
    assert L.apply_reference(other)["1"]["inputs"]["strength"] == 1.0   # not a Soundstage prompt


def test_on_prompt_handler_never_raises():
    from soundstage.takecheck import routes as RT
    body = {"prompt": _l2r_prompt()}
    assert RT.on_prompt_reference(body)["prompt"]["9002:9042"]["inputs"]["strength"] == 0.5
    assert RT.on_prompt_reference({"prompt": None}) == {"prompt": None}
    assert RT.on_prompt_reference({}) == {}


def test_steps_1_never_reports_fewer_steps_than_it_renders():
    """resolve() and the Advanced pop-over allowed 4-7 stage-1 steps, but sigmas_1 built at least 8: settings_json and
    the time estimate said 5 while 8 rendered. Now 5 renders 5 (the distilled curve thinned)."""
    r = L.resolve({"preset": "Draft", "steps_1": 5})
    assert r["steps_1"] == 5 and len(L.sigmas_1(r["steps_1"]).split(",")) - 1 == 5
    assert len(L.schedules(r)[0].split(",")) - 1 == 5
