"""Performance capture + render (docs/performance.md): the expansion graphs are valid against the pod's /object_info
(tests/test_performance_object_info.json + the footage / motion snapshots), the render keeps Mike's union-control
settings and adds the lip-sync audio noise mask in both stages, and the asset helpers (consent, mouth-open curve, fit
boxes, syllable onsets) behave. No ComfyUI, torch or GPU needed.
Run:  python -m pytest tests/test_performance.py -q
"""
import json
import os
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)

import test_footage_graphs as TF  # noqa: E402
from soundstage.performance import asset as A  # noqa: E402
from soundstage.performance import graphs as PG  # noqa: E402

SNAPS = [os.path.join(HERE, f) for f in ("test_motion_object_info.json", "test_performance_object_info.json")]
W = {r: names[0] for r, (f, names) in PG.WEIGHTS.items()}
OWN = {"SoundstagePoseFit": ({"pose": "IMAGE", "width": "INT", "height": "INT", "actor_box": "STRING",
                              "target_box": "STRING"}, ["IMAGE"])}


@pytest.fixture(autouse=True)
def _snapshot(monkeypatch):
    merged = dict(TF.OI)
    for s in SNAPS:
        if os.path.exists(s):
            merged.update(json.load(open(s)))
    monkeypatch.setattr(TF, "OI", merged)
    monkeypatch.setattr(TF, "OWN", {**TF.OWN, **OWN})


needs_snap = pytest.mark.skipif(not TF.OI, reason="no object_info snapshot")


def render_graph(**kw):
    g = TF.Graph()
    p = {"pose": TF.up("plate"), "first": TF.up("first"), "audio": TF.up("audio"), "frames": 97, "fps": 24.0,
         "width": 1280, "height": 704, "prompt": "a woman in a diner", "seed": 5, "quality": "Draft"}
    p.update(kw)
    TF.UPSTREAM.setdefault("audio", "AUDIO")
    return g, PG.render(g, W, p)


@needs_snap
@pytest.mark.parametrize("quality", ["Draft", "Final", "Hollywood"])
@pytest.mark.parametrize("audio", [True, False])
def test_render_graph_valid(quality, audio):
    g, out = render_graph(quality=quality, **({} if audio else {"audio": None}))
    assert TF.check(g) == []
    assert (out["audio"] is not None) == audio
    assert len(g.of("SamplerCustomAdvanced")) == (1 if quality == "Draft" else 2)


def test_render_keeps_union_control_settings():
    g, _ = render_graph(quality="Final")
    lora = g.of("LTXICLoRALoaderModelOnly")[0].inputs
    assert "union-control" in lora["lora_name"] and lora["strength_model"] == 1.0
    sig = [n.inputs["sigmas"] for n in g.of("ManualSigmas")]
    assert sig == [PG.FG.LTX_SIGMAS_STAGE1, PG.FG.LTX_SIGMAS_STAGE2]
    assert [n.inputs["sampler_name"] for n in g.of("KSamplerSelect")] == ["euler_ancestral", "euler"]
    assert all(n.inputs["cfg"] == 1.0 for n in g.of("CFGGuider"))
    gd = g.of("LTXAddVideoICLoRAGuide")[0].inputs
    assert (gd["frame_idx"], gd["strength"], gd["crop"]) == (0, 1.0, "disabled")
    assert len(g.of("LTXVImgToVideoInplace")) == 2          # the shot's frame holds stage 1 and stage 2


def test_voice_reaches_the_sampler_with_the_lipsync_mask():
    g, out = render_graph(quality="Final")
    masks = g.of("SoundstageLatentNoiseMask")
    assert len(masks) == 1 and masks[0].inputs["value"] == PG.AUDIO_MASK == 0.3
    mask_link = [masks[0].id, 0]
    concats = g.of("LTXVConcatAVLatent")
    assert len(concats) == 2 and all(c.inputs["audio_latent"] == mask_link for c in concats)   # both stages
    ref = g.of("LTXVSetAudioRefTokens")[0].inputs
    raw = g.of("VAEEncodeAudio")[0]
    assert ref["audio_latent"] == [raw.id, 0] and masks[0].inputs["latent"] == [raw.id, 0]
    fit = g.of("SoundstageAudioFit")[0]
    assert out["audio"] == [fit.id, 0] and fit.inputs["frames"] == 97
    pos = [n.inputs["text"] for n in g.of("CLIPTextEncode")]
    assert any("lip-sync" in t for t in pos)


def test_audio_mask_is_a_setting():
    g, _ = render_graph(audio_mask=0.45)
    assert g.of("SoundstageLatentNoiseMask")[0].inputs["value"] == 0.45


@needs_snap
def test_layout_pass_screens_under_the_skeleton():
    g, _ = render_graph(layout=TF.up("plate"), layout_mix=0.35)
    assert TF.check(g) == []
    b = g.of("ImageBlend")[0].inputs
    assert (b["blend_mode"], b["blend_factor"]) == ("screen", 0.35)
    g2, _ = render_graph()
    assert not g2.of("ImageBlend")


@pytest.mark.parametrize("q,want", [("Draft", (960, 512)), ("Final", (960, 512)), ("Hollywood", (1280, 704))])
def test_render_size(q, want):
    w, h = PG.render_size(1280, 704, q)
    assert (w, h) == want and w % 64 == 0 and h % 64 == 0


@needs_snap
def test_capture_graph_reads_body_hands_face():
    g = TF.Graph()
    clip, pose = PG.capture(g, {"source": "perf.mp4 [input]", "fps": 24.0, "max_frames": 121})
    assert TF.check(g) == []
    dw = pose.inputs
    assert (dw["detect_body"], dw["detect_hand"], dw["detect_face"], dw["resolution"]) == ("enable", "enable", "enable", 768)
    assert clip.inputs["fps"] == 24.0


def test_prompt_adds_lipsync_once():
    assert PG.prompt_text("", True) == PG.LIPSYNC_HINT
    assert PG.prompt_text("He sings, lip-sync perfect", True) == "He sings, lip-sync perfect"
    assert PG.prompt_text("quiet", False) == "quiet"


# ------------------------------------------------------------------ asset helpers

def face68(open_gap=0.0, scale=1.0, conf=1.0):
    """A plausible 68+2 point face: nose bridge (27) at y 0.3, chin (8) at y 0.6, inner lips 62/66 `open_gap` apart."""
    pts = [[0.5 * scale, 0.45 * scale, conf] for _ in range(70)]
    pts[27] = [0.5 * scale, 0.30 * scale, conf]
    pts[8] = [0.5 * scale, 0.60 * scale, conf]
    pts[62] = [0.5 * scale, 0.50 * scale, conf]
    pts[66] = [0.5 * scale, (0.50 + open_gap) * scale, conf]
    return [v for p in pts for v in p]


def test_mouth_open_is_scale_free():
    a = A.mouth_open(face68(0.03))
    b = A.mouth_open(face68(0.03, scale=720))
    assert a == b == pytest.approx(0.1, abs=1e-3)
    assert A.mouth_open(face68(0.0)) == 0.0
    assert A.mouth_open(face68(0.03, conf=0.0)) is None
    assert A.mouth_open([]) is None


def test_read_keypoints_picks_the_biggest_person():
    small = {"pose_keypoints_2d": [0.1, 0.1, 1, 0.15, 0.2, 1], "face_keypoints_2d": face68(0.0)}
    big = {"pose_keypoints_2d": [0.3, 0.1, 1, 0.7, 0.9, 1], "face_keypoints_2d": face68(0.05)}
    kp = A.read_keypoints([{"people": [small, big], "canvas_width": 1280, "canvas_height": 704},
                           {"people": [], "canvas_width": 1280, "canvas_height": 704}])
    assert kp["frames"][0]["mouth"] == pytest.approx(0.1667, abs=1e-3)
    assert kp["frames"][1]["mouth"] is None and kp["face_seen"] == 0.5
    assert kp["frames"][0]["box"][0] == pytest.approx(0.3) and len(kp["frames"][0]["face"]) == 70


def test_consent_is_required():
    with pytest.raises(A.PerformanceError):
        A.check_consent("Jane Doe", False)
    with pytest.raises(A.PerformanceError):
        A.check_consent("  ", True)
    rec = A.check_consent("Jane Doe", True)
    assert rec["performer"] == "Jane Doe" and rec["statement"] == A.CONSENT_TEXT and rec["date"]
    with pytest.raises(A.PerformanceError):
        A.require_consent({"consent": {}})
    assert A.require_consent({"consent": rec}) == rec


def test_fit_transform_puts_actor_on_character():
    s, dx, dy = A.fit_transform([0.4, 0.1, 0.6, 0.9], [0.1, 0.5, 0.2, 0.9])
    assert s == pytest.approx(0.5)
    # actor centre x 0.5 -> 0.15, top 0.1 -> 0.5
    assert 0.5 * s + dx == pytest.approx(0.15) and 0.1 * s + dy == pytest.approx(0.5)


@pytest.mark.parametrize("text,want", [("", None), ("[0.1,0.2,0.3,0.4]", [0.1, 0.2, 0.3, 0.4]),
                                        ('{"box":[0,0,1,1]}', [0.0, 0.0, 1.0, 1.0]), ("[0.5,0.2,0.3,0.4]", None),
                                        ("nope", None)])
def test_parse_box(text, want):
    assert A.parse_box(text) == want


def test_onsets_find_syllables():
    shut, opened = 0.0, 0.2
    curve = ([shut] * 5 + [opened] * 4) * 3 + [None, shut]
    on = A.onsets(curve, 24.0)
    assert on == [pytest.approx(5 / 24, abs=1e-3), pytest.approx(14 / 24, abs=1e-3), pytest.approx(23 / 24, abs=1e-3)]
    assert A.onsets([], 24.0) == [] and A.onsets([None, None], 24.0) == []


def test_asset_record_shape():
    kp = A.read_keypoints([{"people": [{"pose_keypoints_2d": [0.3, 0.1, 1, 0.7, 0.9, 1], "face_keypoints_2d": face68(0.02)}],
                            "canvas_width": 640, "canvas_height": 360}])
    rec = A.asset_record(aid="t_1", name="t", consent=A.check_consent("me", True), source="x.mp4 [input]", fps=24.0,
                         frames=1, width=640, height=360, has_audio=True, files={"pose": "p"}, keypoints=kp)
    assert rec["kind"] == "soundstage_performance" and rec["box"] == [0.3, 0.1, 0.7, 0.9]
    assert rec["mouth"] == [pytest.approx(0.0667, abs=1e-3)] and rec["seconds"] == pytest.approx(1 / 24, abs=1e-3)
