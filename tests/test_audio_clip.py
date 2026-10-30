"""Audio clips, DSP, prompt hygiene, engine filtering and QC verdicts. No ComfyUI, torch or GPU.

Run from tests/:  cd tests && python -m pytest test_audio_clip.py test_audio_graphs.py
"""
import json
import os
import sys

import numpy as np
import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from soundstage.audio import clip as C  # noqa: E402
from soundstage.audio import engines as E  # noqa: E402
from soundstage.audio import prompts as PR  # noqa: E402
from soundstage.audio import qc as Q  # noqa: E402

SR = 48000


def tone(seconds, freq=440.0, sr=SR, amp=0.5):
    t = np.arange(int(seconds * sr)) / sr
    return (amp * np.sin(2 * np.pi * freq * t)).astype(np.float32)[:, None]


def clicks(times, length, sr=SR):
    x = np.zeros((int(length * sr), 1), np.float32)
    for t in times:
        s = int(t * sr)
        x[s:s + 480, 0] = np.hanning(480) * 0.8
    return x


# ---------------------------------------------------------------- clip contract

def test_track_numbers():
    assert C.track_number("DX1") == 1 and C.track_number("fx2") == 4 and C.track_number("MX1") == 5
    assert C.track_number("A3") == 3 and C.track_number(6) == 6
    with pytest.raises(ValueError):
        C.track_number("XX9")


def test_frames_for():
    assert C.frames_for(1.0, 24) == 24
    assert C.frames_for(1.01, 24) == 25
    assert C.frames_for(0.0, 24) == 1


def test_make_clip_matches_cut_contract():
    from soundstage.cut.export import normalize_audio
    c = C.make_clip("door_001", "FX1", "soundstage_audio/shot1/door_001.wav", 24, SR * 2 + 100, SR,
                    start_frame=60, gain_db=-3.04, fade_in=2, fade_out=500, label="door")
    assert c["track"] == 3 and c["in"] == 0 and c["out"] == c["frames"] == 49
    assert c["fade_out"] == 47  # clamped to the remaining length
    n = normalize_audio([c])[0]
    for k in ("id", "track", "path", "start_frame", "in", "out", "gain_db", "fade_in", "fade_out", "label", "frames"):
        assert n[k] == c[k], k
    assert n["meta"]["track_name"] == "FX1"


def test_wav_roundtrip_24bit(tmp_path):
    x = C.to_channels(tone(0.5), 2)
    p = C.write_wav(str(tmp_path / "a.wav"), x)
    y, sr = C.read_wav(p)
    assert sr == SR and y.shape == x.shape
    assert np.max(np.abs(y - x)) < 1e-4


def test_wav_stdlib_fallback(tmp_path, monkeypatch):
    import builtins
    real = builtins.__import__

    def no_sf(name, *a, **k):
        if name == "soundfile":
            raise ImportError
        return real(name, *a, **k)
    monkeypatch.setattr(builtins, "__import__", no_sf)
    x = C.to_channels(tone(0.2), 2)
    p = C.write_wav(str(tmp_path / "b.wav"), x)
    y, sr = C.read_wav(p)
    assert sr == SR and np.max(np.abs(y - x)) < 1e-4


def test_trim_fit_fades_normalize():
    x = np.concatenate([np.zeros((SR, 1), np.float32), tone(1.0), np.zeros((SR, 1), np.float32)])
    t = C.trim_silence(x, SR)
    assert 1.2 < len(t) / SR < 1.4
    f = C.fit_to_frames(t, SR, 97, 24)
    assert len(f) == round(97 / 24 * SR)
    f2 = C.fit_to_frames(t, SR, 24, 24, offset_s=-0.5)
    assert np.all(f2[: SR // 2] == 0)
    a = C.apply_fades(tone(1.0), SR, 0.1, 0.1)
    assert abs(a[0, 0]) < 1e-6 and abs(a[-1, 0]) < 1e-6
    assert C.peak_dbfs(C.normalize_peak(tone(1.0, amp=0.1), -3.0)) == pytest.approx(-3.0, abs=0.05)


def test_resample_and_channels():
    y = C.resample(tone(1.0, sr=24000), 24000, SR)
    assert abs(len(y) - SR) <= 2
    assert C.to_channels(tone(0.1), 2).shape[1] == 2
    assert C.to_channels(C.to_channels(tone(0.1), 2), 1).shape[1] == 1


def test_onsets_find_footsteps():
    steps = [0.3, 0.85, 1.4, 1.95, 2.5]
    found = C.onsets(clicks(steps, 3.0), SR)
    assert len(found) == len(steps)
    assert all(abs(a - b) < 0.03 for a, b in zip(found, steps))


def test_finish_writes_clip(tmp_path):
    x = np.concatenate([np.zeros((SR // 2, 1), np.float32), tone(1.0, sr=24000), np.zeros((SR // 2, 1), np.float32)])
    y, clip = C.finish(x, 24000, str(tmp_path), "soundstage_audio/shot1", clip_id="hatch_line_001", track="DX1",
                       fps=24, label="HATCH: hi", trim=True, normalize_db=-3.0, start_frame=12)
    assert os.path.exists(tmp_path / clip["path"])
    assert clip["track"] == 1 and clip["start_frame"] == 12 and clip["meta"]["sample_rate"] == SR
    assert clip["meta"]["peak_dbfs"] == pytest.approx(-3.0, abs=0.05)
    assert C.unique_id("hatch_line", str(tmp_path / "soundstage_audio/shot1")) == "hatch_line_002"  # 001 exists now


def test_clip_mixes_through_cut_mixdown(tmp_path):
    """A generated clip placed on the Cut timeline comes back in the shot's mixdown at its start frame."""
    from soundstage.cut.mix import write_mixdown
    out = tmp_path
    _, door = C.finish(clicks([0.05], 0.5), SR, str(out), "soundstage_audio/walkin", clip_id="door_001",
                       track="FX2", fps=24, start_frame=72)
    _, steps = C.finish(clicks([0.1, 0.6, 1.1], 1.5), SR, str(out), "soundstage_audio/walkin",
                        clip_id="steps_001", track="FX1", fps=24, start_frame=0)
    project = {"name": "walkin", "fps": 24, "shots": [{"id": "walkin", "frames": 97}],
               "cut": [{"shot_id": "walkin", "in": 0, "out": 97}], "audio": [steps, door],
               "audio_tracks": C.DEFAULT_AUDIO_TRACKS}
    idx = write_mixdown(project, str(out / "cut"), {"output": str(out)})
    assert not idx["problems"], idx["problems"]
    shot = idx["shots"][0]
    mix, sr = C.read_wav(shot["path"])
    assert len(mix) == round(97 / 24 * SR)
    found = C.onsets(mix, sr)
    assert any(abs(t - 3.05) < 0.04 for t in found), found  # door at frame 72 + 0.05 s
    assert any(abs(t - 0.1) < 0.04 for t in found), found


# ---------------------------------------------------------------- prompts

def test_sfx_prompt_swaps_leak_words():
    p, w = PR.sfx_prompt("Old truck engine barks and coughs to life")
    assert "bark" not in p.lower() and "cough" not in p.lower()
    assert p.endswith(PR.SFX_GUARD) and len(w) == 2


def test_sfx_prompt_flags_sequences_and_named_animals():
    _, w = PR.sfx_prompt("door opens, then slams, then a dog barks")
    assert any("several sound events" in x for x in w)
    assert any("dog" in x for x in w)
    p, w2 = PR.sfx_prompt("a dog barks twice", allow=["dog", "bark", "barks"])
    assert "barks" in p and not any("dog" in x for x in w2)


def test_music_brief_and_dialogue_text():
    b = PR.music_brief("western", "tense", 80, 8, "solo trumpet")
    assert "80 BPM" in b and "no vocals" in b and "solo trumpet" in b
    assert PR.dialogue_text("(beat) You owe me.   [sigh] Pay up.") == "You owe me. [sigh] Pay up."


def test_word_error_rate():
    assert PR.word_error_rate("You owe me money", "you owe me money.") == 0.0
    assert PR.word_error_rate("You owe me money", "you own money") == 0.5


# ---------------------------------------------------------------- engines

def test_engine_filtering(monkeypatch):
    loaded = {"LTXVAudioOnlyModel", "LTXVAudioOnlyEmptyVideoLatent", "ElevenLabsTextToSoundEffects", *E.LTX_CORE}
    files = {"diffusion_models": [E.LTX_WEIGHTS[0]["any"][0]], "text_encoders": [E.LTX_WEIGHTS[1]["any"][0]],
             "vae": ["ltx-2.5-video-vae-bf16.safetensors", "ltx-2.5-audio-vae-bf16.safetensors"]}
    lf = lambda f: files.get(f, [])  # noqa: E731
    sfx = [e["key"] for e in E.available("sfx", loaded, lf, open_only=False)]
    assert sfx == ["ltx_t2a", "elevenlabs_sfx"]  # open first, partner after
    assert [e["key"] for e in E.available("sfx", loaded, lf, open_only=True)] == ["ltx_t2a"]
    dx = E.available("dialogue", loaded, lf, has_package=lambda n: True, open_only=False)
    assert [e["key"] for e in dx] == ["chatterbox"]  # ElevenLabs TTS nodes not loaded here
    el = loaded | {"ElevenLabsVoiceSelector", "ElevenLabsTextToSpeech", "ElevenLabsInstantVoiceClone",
                   "ElevenLabsSpeechToSpeech"}
    assert [e["key"] for e in E.available("voice_change", el, lf, has_package=lambda n: True, open_only=False)] == \
        ["chatterbox_vc", "elevenlabs_sts"]
    assert [e["key"] for e in E.available("music", el, lf, open_only=False)] == ["ltx_t2a"]
    assert E.available("dialogue", set(), lf, has_package=lambda n: False)[0]["key"] == "chatterbox"  # never empty
    monkeypatch.setenv(E.OPEN_ONLY_ENV, "1")
    assert E.open_weights_only()


def test_resolve_weights_subfolder():
    e = {"weights": E.LTX_WEIGHTS}
    w = E.resolve_weights(e, lambda f: ["ltx2.5/ltx-2.5-22b-ic-lora-layout-to-render-1.0.safetensors"] if f == "loras" else [])
    assert w["l2r_lora"].startswith("ltx2.5/") and w["unet"] is None


def test_labels_unique_and_badged():
    for dept, lst in E.ENGINES.items():
        labels = [e["label"] for e in lst]
        assert len(set(labels)) == len(labels)
        assert lst[0]["kind"] != "api", f"{dept} must default to open weights"
        for e in lst:
            assert ("[API]" in e["label"]) == (e["kind"] == "api")


# ---------------------------------------------------------------- QC verdicts

def test_judge_sfx():
    ok = Q.judge("sfx", "a heavy door slams", {"Door": 0.62, "Slam": 0.4, "Music": 0.2})
    assert ok["pass"] and ok["verified"]
    dog = Q.judge("sfx", "a heavy door slams", {"Door": 0.5, "Dog": 0.55, "Bark": 0.5})
    assert not dog["pass"] and any("Dog" in i for i in dog["issues"])
    miss = Q.judge("sfx", "footsteps on gravel", {"Music": 0.3, "Hum": 0.4})
    assert not miss["pass"] and any("expected" in i for i in miss["issues"])
    drone = Q.judge("sfx", "engine idling", {"Engine": 0.5, "Music": 0.3, "Speech": 0.16})
    assert drone["pass"], drone  # field note: Music ~0.3 / Speech ~0.16 on a drone are false positives


def test_judge_dialogue_and_unverified():
    r = Q.judge("dialogue", "", None, transcript="you owe me money", line="You owe me money.")
    assert r["pass"] and r["verified"]
    bad = Q.judge("dialogue", "", None, transcript="hello there", line="You owe me money.")
    assert not bad["pass"]
    basic = Q.basic_stats(np.zeros((SR, 2), np.float32), SR)
    u = Q.judge("sfx", "door", None, basic=basic)
    assert not u["verified"] and not u["pass"] and "clip is silent" in u["issues"]


def test_expected_labels():
    assert "Walk, footsteps" in Q.expected_labels("Footsteps on stone.")
    assert "Door" in Q.expected_labels("glass doors slide open")
    assert Q.expected_labels("ambient plaza tone") == []


def test_clip_json_is_json():
    c = C.make_clip("x", "MX1", "a/b.wav", 24, SR, SR)
    assert json.loads(C.dumps(c))["track"] == 5


# ---------------------------------------------------------------- character voices

def test_voice_consent_and_roundtrip(tmp_path):
    from soundstage.audio import voices as VV
    ref = np.concatenate([np.zeros((SR // 2, 1), np.float32), tone(6.0, 180), np.zeros((SR // 2, 1), np.float32)])
    with pytest.raises(VV.VoiceError, match="consent"):
        VV.save_voice(str(tmp_path), "PIP", ref, SR, consent=False, owner="me")
    with pytest.raises(VV.VoiceError, match="whose voice"):
        VV.save_voice(str(tmp_path), "PIP", ref, SR, consent=True, owner=" ")
    with pytest.raises(VV.VoiceError, match="at least"):
        VV.save_voice(str(tmp_path), "PIP", tone(1.0), SR, consent=True, owner="me")
    v = VV.save_voice(str(tmp_path), "Pip the puppet", ref, SR, consent=True, owner="me", character="PIP")
    assert v["name"] == "Pip_the_puppet" and 5.9 < v["duration_s"] < 6.4 and v["consent"]["confirmed"]
    assert VV.list_voices(str(tmp_path)) == ["Pip_the_puppet"]
    w = VV.load_voice(str(tmp_path), "Pip the puppet")
    y, sr = C.read_wav(w["path"])
    assert sr == SR and y.shape[1] == 1
    assert "owner" in VV.public(w) and "path" not in VV.public(w)
    with pytest.raises(VV.VoiceError, match="No saved voice"):
        VV.load_voice(str(tmp_path), "nobody")


def test_voice_without_consent_record_refused(tmp_path):
    from soundstage.audio import voices as VV
    d = VV.voice_dir(str(tmp_path))
    json.dump({"name": "X", "reference": "X.wav"}, open(os.path.join(d, "X.json"), "w"))
    with pytest.raises(VV.VoiceError, match="consent"):
        VV.load_voice(str(tmp_path), "X")
