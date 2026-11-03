"""Voice-conversion routing (no ComfyUI, no GPU): which engine a voice change picks for what is installed and the
open-weights switch, what the ElevenLabs speech-to-speech graph looks like for every model, preset voice and seed
(checked against the pod's /object_info), how a saved Character Voice is found by name (and that the App's matcher
in web/performance/performance.mjs gives the same answer as the server's voices.resolve_name), and that one broken
voice file never breaks the others.
Run:  python -m pytest tests/test_voice_routing.py -q
"""
import json
import os
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
sys.path.insert(0, HERE)

import test_audio_graphs as TA  # noqa: E402
from soundstage.audio import engines as E  # noqa: E402
from soundstage.audio import graphs as G  # noqa: E402
from soundstage.audio import voices as V  # noqa: E402

SR = 48000
EL_STS = {"ElevenLabsVoiceSelector", "ElevenLabsSpeechToSpeech", "ElevenLabsInstantVoiceClone"}
WEB = Path(ROOT) / "web" / "performance" / "performance.mjs"


def keys(dept, loaded=frozenset(), pkg=True, open_only=False):
    return [e["key"] for e in E.available(dept, set(loaded), lambda f: [], has_package=lambda n: pkg, open_only=open_only)]


# ---------------------------------------------------------------- which engine a voice change runs on

def test_voice_change_picks_chatterbox_first_and_elevenlabs_only_when_partner_models_are_on():
    assert keys("voice_change", EL_STS, pkg=True, open_only=False) == ["chatterbox_vc", "elevenlabs_sts"]
    assert keys("voice_change", EL_STS, pkg=True, open_only=True) == ["chatterbox_vc"]
    # chatterbox not installed: the partner engine is the only one that runs ...
    assert keys("voice_change", EL_STS, pkg=False, open_only=False) == ["elevenlabs_sts"]
    # ... and with partner models off, or its nodes missing, the local engine is still listed so the node says what's missing
    for loaded, open_only in ((EL_STS, True), (set(), False), (EL_STS - {"ElevenLabsInstantVoiceClone"}, False)):
        assert keys("voice_change", loaded, pkg=False, open_only=open_only) == ["chatterbox_vc"]
    vc = E.find("voice_change", "chatterbox_vc")
    assert E.missing(vc, set(), lambda f: [], lambda n: False) == ["python package chatterbox"]
    sts = E.find("voice_change", "elevenlabs_sts")
    assert E.missing(sts, {"ElevenLabsVoiceSelector"}, lambda f: []) == ["ElevenLabsSpeechToSpeech", "ElevenLabsInstantVoiceClone"]


def test_engines_are_found_by_label_or_key_and_never_across_departments():
    for e in E.ENGINES["voice_change"]:
        assert E.find("voice_change", e["label"]) is e and E.find("voice_change", e["key"]) is e
    assert E.find("voice_change", "chatterbox") is None, "the TTS engine is not a voice changer"
    assert E.find("dialogue", "chatterbox_vc") is None
    assert E.find("voice_change", "") is None and E.find("voice_change", None) is None


@pytest.mark.parametrize("env,open_only", [({}, True), ({E.PARTNER_ENV: "1"}, False), ({E.PARTNER_ENV: "yes"}, False),
                                           ({E.OPEN_ONLY_ENV: "0"}, False), ({E.OPEN_ONLY_ENV: "off"}, False),
                                           ({E.OPEN_ONLY_ENV: "1", E.PARTNER_ENV: "on"}, False),
                                           ({E.PARTNER_ENV: "0"}, True), ({E.OPEN_ONLY_ENV: "1"}, True)])
def test_partner_switch(monkeypatch, env, open_only):
    monkeypatch.delenv(E.PARTNER_ENV, raising=False)
    monkeypatch.delenv(E.OPEN_ONLY_ENV, raising=False)
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    assert E.open_weights_only() is open_only
    assert ("elevenlabs_sts" in keys("voice_change", EL_STS, open_only=None)) is (not open_only)


# ---------------------------------------------------------------- the partner graph for every model, voice and seed

STS_PARAMS = {p["id"]: p for p in E.find("voice_change", "elevenlabs_sts")["params"]}


@pytest.mark.parametrize("model", STS_PARAMS["model"]["options"])
@pytest.mark.parametrize("seed", [0, 9, -1, 2 ** 32 - 1, 2 ** 32, 2 ** 64 + 3])
@pytest.mark.parametrize("clone", [False, True])
def test_sts_graph_valid_for_every_model_and_any_seed(model, seed, clone):
    g = TA.FakeGraph()
    a = G.elevenlabs_sts(g, TA.link("audio"), seed, {"model": model}, clone_audio=TA._voice_link(g) if clone else None)
    TA.validate(g)          # includes the seed inside the node's 0 .. 2**32-1
    assert TA.out_type(g, a) == "AUDIO"
    voice = g.nodes[g.nodes[a[0]].inputs["voice"][0]]
    assert voice.class_type == ("ElevenLabsInstantVoiceClone" if clone else "ElevenLabsVoiceSelector")


def test_every_preset_voice_and_param_edge_is_a_valid_sts_graph():
    for voice in [STS_PARAMS["preset_voice"]["default"], *STS_PARAMS["preset_voice"]["options"]]:
        TA.validate(_sts({"preset_voice": voice}))
    for k in ("stability", "similarity"):
        for v in (STS_PARAMS[k]["min"], STS_PARAMS[k]["max"]):
            TA.validate(_sts({k: v}))
    TA.validate(_sts({}))          # the node's defaults alone
    assert set(STS_PARAMS["preset_voice"]["options"]) == \
        set(TA.OBJECT_INFO["ElevenLabsVoiceSelector"]["input"]["required"]["voice"][1]["options"])


def _sts(params):
    g = TA.FakeGraph()
    G.elevenlabs_sts(g, TA.link("audio"), 1, params)
    return g


# ---------------------------------------------------------------- saved voices: name matching

def _tone(seconds=5.0):
    t = np.arange(int(seconds * SR)) / SR
    return (0.3 * np.sin(2 * np.pi * 140 * t)).astype(np.float32)[:, None]


@pytest.fixture
def cast(tmp_path):
    d = str(tmp_path)
    for name, character in [("EZRA_HALE", "EZRA HALE"), ("MARA_VOSS", "MARA VOSS"), ("Jordan", "Jordan Lee"),
                            ("PIP", "PIP"), ("Old_Ben", "Ben Kenobi")]:
        V.save_voice(d, name, _tone(), SR, consent=True, owner="designed", character=character)
    return d


def test_a_cue_with_extra_spaces_finds_the_voice(cast):
    """'Mara  Voss' (two spaces, a typed cue) was saved-name 'Mara__Voss' on the server while the App reads MARA_VOSS."""
    assert V.safe_name("Mara  Voss") == "Mara_Voss"
    assert V.resolve_name(cast, "Mara  Voss") == "MARA_VOSS"
    assert V.resolve_name(cast, "  ezra   hale ") == "EZRA_HALE"
    assert V.resolve_name(cast, "ben  kenobi") == "Old_Ben"


def test_name_matching_never_borrows_and_never_crosses_paths(cast):
    assert V.resolve_name(cast, "Ben") == "Old_Ben"                    # first name of the character it was saved for
    assert V.resolve_name(cast, "Ezra Cole") is None
    assert V.resolve_name(cast, "Ezr") is None, "a prefix is not a first name"
    assert V.resolve_name(cast, "../EZRA_HALE") == "EZRA_HALE"       # the path is stripped, never followed
    with pytest.raises(V.VoiceError):
        V.resolve_name(cast, "../..")
    with pytest.raises(V.VoiceError):
        V.load_voice(cast, "")


def test_one_broken_voice_file_never_breaks_the_others(cast):
    d = V.voice_dir(cast)
    for name, body in [("A_LIST", "[1, 2]"), ("A_TEXT", "not json"), ("A_NUM", "7"), ("A_STR", '"x"'),
                       ("A_CONSENT", json.dumps({"name": "A_CONSENT", "reference": "PIP.wav", "consent": "yes"}))]:
        with open(os.path.join(d, name + ".json"), "w") as f:
            f.write(body)
    assert V.resolve_name(cast, "Jordan Lee") == "Jordan"            # reads every record's character: no crash
    assert V.load_voice(cast, "Mara")["name"] == "MARA_VOSS"
    for name in ("A_LIST", "A_NUM", "A_STR", "A_CONSENT"):
        with pytest.raises(V.VoiceError):
            V.load_voice(cast, name)
    with pytest.raises(ValueError):                                  # VoiceError or a JSON error: both are ValueErrors
        V.load_voice(cast, "A_TEXT")


def test_a_voice_record_cannot_point_its_recording_outside_the_voices_folder(cast, tmp_path):
    d = V.voice_dir(cast)
    (tmp_path / "outside.wav").write_bytes(open(os.path.join(d, "PIP.wav"), "rb").read())
    for ref in ("../../outside.wav", str(tmp_path / "outside.wav"), "sub/PIP.wav", "..\\PIP.wav", None, 3):
        rec = {"name": "EVIL", "character": "EVIL", "reference": ref, "consent": {"confirmed": True, "owner": "x"}}
        with open(os.path.join(d, "EVIL.json"), "w") as f:
            json.dump(rec, f)
        with pytest.raises(V.VoiceError, match="not a file in the voices folder"):
            V.load_voice(cast, "EVIL")
    rec["reference"] = "PIP.wav"                                      # a sibling recording is fine
    del rec["name"]
    with open(os.path.join(d, "EVIL.json"), "w") as f:
        json.dump(rec, f)
    assert V.load_voice(cast, "EVIL")["name"] == "EVIL"               # a record without a name is named by its file


def test_voices_route_lists_the_good_voices_past_a_broken_file(cast, monkeypatch):
    web = pytest.importorskip("aiohttp.web")
    d = V.voice_dir(cast)
    with open(os.path.join(d, "BROKEN.json"), "w") as f:
        f.write("[]")
    with open(os.path.join(d, "NONAME.json"), "w") as f:
        json.dump({"reference": "PIP.wav", "consent": {"confirmed": True, "owner": "me"}}, f)
    fake_fp = type(sys)("folder_paths")
    fake_fp.get_user_directory = lambda: cast
    table = web.RouteTableDef()
    srv = type(sys)("server")
    srv.PromptServer = type("PS", (), {"instance": type("I", (), {"routes": table, "app": web.Application()})()})
    monkeypatch.setitem(sys.modules, "folder_paths", fake_fp)
    monkeypatch.setitem(sys.modules, "server", srv)
    from soundstage.handoff import routes as HR
    from soundstage.oneclick import routes as OR
    monkeypatch.setattr(HR, "_REGISTERED", True)                      # leave the other route modules alone
    monkeypatch.setattr(OR, "_REGISTERED", True)
    monkeypatch.delitem(sys.modules, "soundstage.routes", raising=False)
    import importlib
    R = importlib.import_module("soundstage.routes")
    monkeypatch.delitem(sys.modules, "soundstage.routes")
    import asyncio
    resp = asyncio.run(R.saved_voices(None))
    names = [v["name"] for v in json.loads(resp.body)["voices"]]
    assert names == sorted(["EZRA_HALE", "MARA_VOSS", "Jordan", "PIP", "Old_Ben", "NONAME"]), names
    assert "path" not in resp.body.decode()


# ---------------------------------------------------------------- the App and the server agree on names

CUES = ["Ezra", "EZRA", "ezra hale", "Ezra Hale", "Ezra Cole", "Mara", "Mara  Voss", "MARA VOSS", "Jordan",
        "jordan lee", "Jordan Smith", "Pip", "PIP LARK", "Ben", "Ben Kenobi", "Nobody", "Old Ben", "  mara   voss  "]


def _node(code):
    p = subprocess.run(["node", "--input-type=module", "-e", code, WEB.as_uri()], capture_output=True, text=True, timeout=60)
    if p.returncode != 0:
        pytest.skip(f"node not available: {p.stderr[:200]}")
    return json.loads(p.stdout.strip().splitlines()[-1])


def test_app_and_server_pick_the_same_saved_voice_for_every_cue(cast):
    saved = [{"name": n, "character": json.load(open(os.path.join(V.voice_dir(cast), n + ".json")))["character"]}
             for n in V.list_voices(cast)]
    code = ("const m = await import(process.argv[1]);"
            f"const saved = {json.dumps(saved)}, cues = {json.dumps(CUES)};"
            "console.log(JSON.stringify(cues.map((c) => [m.voiceNameFor(c), m.matchVoice(c, saved)])));")
    js = _node(code)
    for cue, (js_name, js_match) in zip(CUES, js):
        assert js_name == V.safe_name(cue).upper(), (cue, js_name)
        assert (js_match or None) == V.resolve_name(cast, cue), (cue, js_match, V.resolve_name(cast, cue))
