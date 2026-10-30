"""Audio QC: does the clip contain what was asked for, and nothing it should not?

- SFX / music: AudioSet classifier MIT/ast-finetuned-audioset-10-10-0.4593 (527 classes, BSD-3), over
  sliding 2 s windows, max score per label. Flags forbidden labels (Dog/Bark/Speech... in an SFX) and
  expected labels that never show up ("door" in the prompt but no Door/Slam/Knock label).
- Dialogue: Whisper (models/whisper/whisper-base) transcribes; word error rate against the line.
- No classifier installed: duration / silence / clipping / onset checks only, marked "unverified".

Models load from local files only (local_files_only=True); nothing is downloaded.
Field notes: AudioSet "Music" 0.2-0.36 and "Speech" ~0.16 on a sustained engine drone are false
positives; Dog/Bark/Bow-wow above 0.3 is real.
"""
import logging
import os

import numpy as np

from . import clip as C
from .prompts import word_error_rate

AST_ID = "MIT/ast-finetuned-audioset-10-10-0.4593"
AST_DIRNAMES = ("ast-finetuned-audioset-10-10-0.4593", "ast")

# prompt keyword -> AudioSet label substrings that count as a match
EXPECT = {
    "footstep": ["Walk, footsteps", "Run", "Shuffle"], "footsteps": ["Walk, footsteps", "Run", "Shuffle"],
    "walk": ["Walk, footsteps"], "walking": ["Walk, footsteps"], "steps": ["Walk, footsteps"],
    "door": ["Door", "Slam", "Knock", "Squeak", "Sliding door", "Cupboard open or close", "Creak"],
    "knock": ["Knock", "Door", "Tap"], "slam": ["Slam", "Door", "Bang"], "creak": ["Creak", "Squeak", "Door"],
    "glass": ["Glass", "Shatter", "Chink, clink"], "shatter": ["Shatter", "Glass", "Breaking"],
    "car": ["Car", "Vehicle", "Engine", "Motor vehicle"], "engine": ["Engine", "Vehicle", "Idling", "Motor"],
    "rain": ["Rain", "Raindrop", "Water"], "wind": ["Wind", "Rustle", "Howl"], "thunder": ["Thunder", "Thunderstorm"],
    "gunshot": ["Gunshot", "Explosion", "Cap gun", "Burst, pop"], "explosion": ["Explosion", "Boom", "Burst"],
    "water": ["Water", "Splash", "Stream", "Pour", "Liquid"], "fire": ["Fire", "Crackle"],
    "bell": ["Bell", "Chime", "Ding"], "phone": ["Telephone", "Ringtone", "Ring"], "clock": ["Clock", "Tick"],
    "typing": ["Typing", "Computer keyboard"], "keys": ["Keys jangling", "Jingle"], "crowd": ["Crowd", "Chatter"],
    "applause": ["Applause", "Clapping"], "whoosh": ["Whoosh, swoosh, swish"], "impact": ["Thump, thud", "Bang"],
    "thud": ["Thump, thud"], "paper": ["Paper rustling", "Rustle"], "plaza": [], "city": ["Traffic", "Urban"],
    "traffic": ["Traffic", "Car", "Vehicle"], "birds": ["Bird", "Chirp"], "ocean": ["Ocean", "Waves, surf"],
    "waves": ["Waves, surf", "Ocean"],
}
FORBIDDEN = {
    "sfx": {"Dog": 0.3, "Bark": 0.3, "Bow-wow": 0.3, "Growling": 0.3, "Howl": 0.35, "Cat": 0.3, "Meow": 0.3,
            "Speech": 0.35, "Singing": 0.3, "Male speech, man speaking": 0.3, "Female speech, woman speaking": 0.3,
            "Music": 0.45},
    "music": {"Speech": 0.4, "Dog": 0.3, "Bark": 0.3},
    "dialogue": {"Dog": 0.3, "Bark": 0.3, "Music": 0.5},
}

_ast = None
_whisper = None


def _candidate_roots():
    roots = []
    try:
        import folder_paths
        roots.append(folder_paths.models_dir)
        for kind in ("checkpoints", "vae"):
            for p in folder_paths.get_folder_paths(kind):
                roots.append(os.path.dirname(os.path.normpath(p)))
    except ImportError:
        pass
    env = os.environ.get("SOUNDSTAGE_AUDIO_MODELS")
    if env:
        roots.insert(0, env)
    return list(dict.fromkeys(roots))


def find_ast():
    for r in _candidate_roots():
        for sub in ("audio_classifiers", "audio_encoders", ""):
            for name in AST_DIRNAMES:
                d = os.path.join(r, sub, name)
                if os.path.exists(os.path.join(d, "config.json")):
                    return d
    try:  # Hugging Face cache, offline
        from huggingface_hub import snapshot_download
        return snapshot_download(AST_ID, local_files_only=True)
    except Exception:  # noqa: BLE001
        return None


def find_whisper():
    for r in _candidate_roots():
        for name in ("whisper-base", "whisper-small", "whisper-base.en"):
            d = os.path.join(r, "whisper", name)
            if os.path.exists(os.path.join(d, "config.json")):
                return d
    return None


def _load_ast(device):
    global _ast
    if _ast is None:
        d = find_ast()
        if d is None:
            return None
        from transformers import ASTFeatureExtractor, ASTForAudioClassification
        _ast = (ASTFeatureExtractor.from_pretrained(d, local_files_only=True),
                ASTForAudioClassification.from_pretrained(d, local_files_only=True).eval())
        logging.info("Soundstage QC: AST loaded from %s", d)
    _ast[1].to(device)
    return _ast


def _load_whisper(device):
    global _whisper
    if _whisper is None:
        d = find_whisper()
        if d is None:
            return None
        from transformers import WhisperForConditionalGeneration, WhisperProcessor
        _whisper = (WhisperProcessor.from_pretrained(d, local_files_only=True),
                    WhisperForConditionalGeneration.from_pretrained(d, local_files_only=True).eval())
    _whisper[1].to(device)
    return _whisper


def classify(x, sr, device="cpu", window_s=2.0, hop_s=1.0, top_k=10):
    """{label: max score over windows} or None when AST is not installed."""
    import torch
    m = _load_ast(device)
    if m is None:
        return None
    fe, model = m
    mono = C.resample(C.to_channels(x, 1), sr, 16000)[:, 0]
    win, hop = int(window_s * 16000), int(hop_s * 16000)
    starts = list(range(0, max(1, len(mono) - win + 1), hop)) or [0]
    scores = {}
    labels = model.config.id2label
    with torch.no_grad():
        for s in starts:
            seg = mono[s:s + win]
            if len(seg) < 1600:
                continue
            inp = fe(seg, sampling_rate=16000, return_tensors="pt").to(device)
            p = torch.sigmoid(model(**inp).logits[0]).cpu().numpy()
            for i in np.argsort(-p)[:top_k]:
                lab = labels[int(i)]
                scores[lab] = max(scores.get(lab, 0.0), round(float(p[i]), 3))
    model.to("cpu")
    return dict(sorted(scores.items(), key=lambda kv: -kv[1]))


def transcribe(x, sr, device="cpu"):
    import torch
    m = _load_whisper(device)
    if m is None:
        return None
    proc, model = m
    mono = C.resample(C.to_channels(x, 1), sr, 16000)[:, 0]
    with torch.no_grad():
        feats = proc(mono, sampling_rate=16000, return_tensors="pt").input_features.to(device)
        ids = model.generate(feats, language="en", task="transcribe")
    model.to("cpu")
    return proc.batch_decode(ids, skip_special_tokens=True)[0].strip()


def expected_labels(prompt):
    words = [w.strip(".,;:!?").lower() for w in (prompt or "").split()]
    out = []
    for w in words:
        for key in (w, w.rstrip("s")):
            if key in EXPECT:
                out += EXPECT[key]
                break
    return list(dict.fromkeys(out))


def judge(kind, prompt, scores, transcript=None, line=None, basic=None, max_wer=0.35):
    """Pure: the verdict from classifier scores / transcript / basic stats. Returns a report dict."""
    issues, notes = [], []
    basic = basic or {}
    if basic.get("silent"):
        issues.append("clip is silent")
    if basic.get("clipping"):
        issues.append(f"clipping (peak {basic.get('peak_dbfs')} dBFS)")
    verified = scores is not None or transcript is not None
    if scores is not None:
        for lab, thr in FORBIDDEN.get(kind, {}).items():
            if scores.get(lab, 0) >= thr:
                issues.append(f"unwanted '{lab}' ({scores[lab]:.2f})")
        exp = expected_labels(prompt) if kind == "sfx" else (["Music"] if kind == "music" else ["Speech"])
        if exp:
            hit = {k: v for k, v in scores.items() if any(e.lower() in k.lower() for e in exp)}
            if not hit or max(hit.values()) < 0.1:
                issues.append("none of the expected sounds were heard (" + ", ".join(exp[:6]) + ")")
            else:
                notes.append("heard " + ", ".join(f"{k} {v:.2f}" for k, v in list(hit.items())[:4]))
        else:
            notes.append("prompt has no known sound words; only checked for unwanted sounds")
    if transcript is not None and line:
        wer = word_error_rate(line, transcript)
        notes.append(f"heard: \"{transcript}\" (WER {wer})")
        if wer > max_wer:
            issues.append(f"words do not match the line (WER {wer} > {max_wer})")
    top = list((scores or {}).items())[:8]
    return {"pass": not issues, "verified": verified, "kind": kind, "issues": issues, "notes": notes,
            "top_labels": [[k, v] for k, v in top], "transcript": transcript, **{"basic": basic}}


def basic_stats(x, sr):
    x = C.as_2d(x)
    peak = C.peak_dbfs(x)
    rms = C.rms_dbfs(x)
    return {"duration_s": round(len(x) / sr, 3), "peak_dbfs": peak, "rms_dbfs": rms,
            "silent": rms is None or rms < -60, "clipping": peak is not None and peak > -0.1,
            "onsets": len(C.onsets(x, sr))}


def check(x, sr, kind, prompt="", line="", device="cpu"):
    basic = basic_stats(x, sr)
    scores = transcript = None
    try:
        scores = classify(x, sr, device)
    except Exception as e:  # noqa: BLE001
        logging.exception("Soundstage QC: classifier failed")
        basic["classifier_error"] = str(e)
    if kind == "dialogue":
        try:
            transcript = transcribe(x, sr, device)
        except Exception as e:  # noqa: BLE001
            logging.exception("Soundstage QC: whisper failed")
            basic["whisper_error"] = str(e)
    rep = judge(kind, prompt, scores, transcript, line or prompt, basic)
    if not rep["verified"]:
        rep["notes"].append("no classifier installed (AST for SFX/music, Whisper for dialogue): basic checks only")
    return rep
