"""Soundstage audio department: dialogue, effects, music, QC, and LTX-2.5 driven by the edited sound.

Every generator returns AUDIO plus a clip JSON in the Cut tab's audio contract (docs/cut.md, docs/audio.md),
so the timeline can place it: {id, track, path, start_frame, in, out, gain_db, fade_in, fade_out, label,
frames, meta}. Clips are written to output/soundstage_audio/<shot_id>/ as 48 kHz / 24-bit WAV.
Tracks: DX1-2 = A1-A2 (dialogue), FX1-2 = A3-A4 (effects), MX1-2 = A5-A6 (music).

Engines are stage-aware like the model router: open weights first and default, partner nodes marked
[API] (hidden with SOUNDSTAGE_OPEN_WEIGHTS_ONLY=1). Local LTX and partner engines are expanded into
their real nodes at run time (GraphBuilder); Chatterbox runs in-process from local weights.
"""
import json
import logging
import os
import time

import numpy as np
import torch

import folder_paths
import nodes
from comfy_api.latest import IO, ui
from comfy_execution.graph_utils import ExecutionBlocker, GraphBuilder

from .audio import clip as C
from .audio import engines as E
from .audio import graphs as G
from .audio import prompts as PR
from .audio import voices as V

OUT_SUBDIR = "soundstage_audio"
Voice = IO.Custom("SOUNDSTAGE_VOICE")
TRACK_OPTIONS = list(C.TRACKS)
_TTL_S = 30
_cache: dict[str, tuple[float, list]] = {}


# ---------------------------------------------------------------- helpers

def _list_files(folder):
    try:
        return folder_paths.get_filename_list(folder)
    except Exception:  # noqa: BLE001  (folder type not registered here)
        return []


def _has_package(name):
    from .audio.tts import has_package
    return has_package(name)


def _engines(dept):
    hit = _cache.get(dept)
    if hit and time.time() - hit[0] < _TTL_S:
        return hit[1]
    opts = E.available(dept, set(nodes.NODE_CLASS_MAPPINGS), _list_files, _has_package)
    _cache[dept] = (time.time(), opts)
    return opts


def _param_widget(p):
    tip = {"tooltip": p["tooltip"]} if p.get("tooltip") else {}
    if p["kind"] == "combo":
        return IO.Combo.Input(p["id"], options=p["options"], default=p["default"], **tip)
    if p["kind"] == "string":
        return IO.String.Input(p["id"], default=p["default"], **tip)
    if p["kind"] == "bool":
        return IO.Boolean.Input(p["id"], default=p["default"], **tip)
    return IO.Float.Input(p["id"], default=p["default"], min=p["min"], max=p["max"], step=0.01, **tip)


def _engine_input(dept, tooltip):
    return IO.DynamicCombo.Input(
        "engine", tooltip=tooltip,
        options=[IO.DynamicCombo.Option(e["label"], [_param_widget(p) for p in e["params"]]) for e in _engines(dept)])


def _pick_engine(dept, value):
    key = value.get("engine") if isinstance(value, dict) else value
    e = E.find(dept, key)
    if e is None:
        raise ValueError(f"Soundstage {dept}: unknown engine {key!r}.")
    if e["kind"] == "api" and E.open_weights_only():
        raise ValueError(f"{e['label']} is a paid partner engine and {E.OPEN_ONLY_ENV}=1 is set.")
    miss = E.missing(e, set(nodes.NODE_CLASS_MAPPINGS), _list_files, _has_package)
    if miss:
        raise ValueError(f"{e['label']} is missing: {', '.join(miss)}")
    params = {k: v for k, v in value.items() if k != "engine"} if isinstance(value, dict) else {}
    return e, params


def _check_api_auth(e, hidden):
    if e["kind"] == "api" and not (hidden.auth_token_comfy_org or hidden.api_key_comfy_org):
        raise ValueError(f"{e['label']} is a paid partner engine: sign in to Comfy (Settings > User) or pick a "
                         "local engine.")


def _ltx_weights():
    e = E.find("sfx", "ltx_t2a")
    w = E.resolve_weights({"weights": E.LTX_WEIGHTS}, _list_files)
    return w if all(w.get(s["role"]) for s in e["weights"]) else None


def audio_to_np(audio):
    """ComfyUI AUDIO {"waveform": [B, C, S], "sample_rate"} -> (float32 [S, C], sr)."""
    wf = audio["waveform"]
    if isinstance(wf, torch.Tensor):
        wf = wf.detach().float().cpu().numpy()
    wf = np.asarray(wf, np.float32)
    if wf.ndim == 3:
        wf = wf[0]
    return np.ascontiguousarray(wf.T), int(audio["sample_rate"])


def np_to_audio(x, sr):
    x = C.as_2d(x)
    return {"waveform": torch.from_numpy(np.ascontiguousarray(x.T))[None].float(), "sample_rate": int(sr)}


def _shot_dir(shot_id):
    rel = os.path.join(OUT_SUBDIR, C.slug(shot_id or "unassigned", "unassigned"))
    full = os.path.join(folder_paths.get_output_directory(), rel)
    os.makedirs(full, exist_ok=True)
    return rel, full


def _user_dir():
    return folder_paths.get_user_directory()


def _voice_input():
    return Voice.Input("voice", optional=True,
                       tooltip="A saved Character Voice (consent-gated). Chatterbox uses it zero-shot; ElevenLabs "
                               "makes an Instant Voice Clone from it. Empty = built-in / preset voice.")


def _voice_ref_link(g, voice):
    """AUDIO link of a saved voice's reference inside an expanded graph (for ElevenLabs cloning)."""
    return g.node("SoundstageVoice", name=voice["name"], consent=False, voice_owner="").out(1) if voice else None


def _media(io_type, name, tooltip):
    return io_type.Input(name, optional=True, lazy=True, raw_link=True, tooltip=tooltip)


def _placement_inputs(default_track):
    return [
        IO.String.Input("shot_id", default="shot1", tooltip="Cut shot id the clip belongs to (folder name too)."),
        IO.Combo.Input("track", options=TRACK_OPTIONS, default=default_track,
                       tooltip="DX1-2 = A1-A2 dialogue, FX1-2 = A3-A4 effects, MX1-2 = A5-A6 music."),
        IO.Int.Input("start_frame", default=0, min=0, max=1_000_000, tooltip="Where the clip starts on the timeline."),
        IO.Float.Input("fps", default=24.0, min=1.0, max=120.0, step=0.001),
        IO.Float.Input("gain_db", default=0.0, min=-60.0, max=24.0, step=0.1, optional=True, advanced=True),
        IO.Int.Input("seed", default=0, min=0, max=0xFFFFFFFFFFFFFFFF, control_after_generate=True),
    ]


CLIP_OUTPUTS = [IO.Audio.Output("out_audio", display_name="audio"), IO.String.Output("out_clip_json", display_name="clip_json"),
                IO.Float.Output("out_duration_s", display_name="duration_s"), IO.Int.Output("out_frames", display_name="frames")]
HIDDEN = [IO.Hidden.unique_id, IO.Hidden.auth_token_comfy_org, IO.Hidden.api_key_comfy_org]


def _finish(x, sr, *, prefix, shot_id, track, fps, start_frame=0, gain_db=0.0, fade_in=0, fade_out=0, trim=False,
            normalize_db=None, max_seconds=None, label="", meta=None):
    rel, full = _shot_dir(shot_id)
    clip_id = C.unique_id(prefix, full)
    y, clip = C.finish(x, sr, folder_paths.get_output_directory(), rel, clip_id=clip_id, track=track, fps=fps,
                       label=label or clip_id, start_frame=start_frame, gain_db=gain_db, fade_in=fade_in,
                       fade_out=fade_out, trim=trim, normalize_db=normalize_db, max_seconds=max_seconds,
                       meta={"shot_id": shot_id, **(meta or {})})
    return y, clip


def _clip_node(g, audio_link, **kw):
    """The SoundstageAudioClip step at the end of every expanded generator graph."""
    return g.node("SoundstageAudioClip", audio=audio_link, label=kw.get("label", ""), shot_id=kw["shot_id"],
                  track=kw["track"], start_frame=int(kw.get("start_frame", 0)), fps=float(kw["fps"]),
                  gain_db=float(kw.get("gain_db", 0.0)), trim_silence=bool(kw.get("trim", False)),
                  normalize_db=float(kw.get("normalize_db", -3.0)), max_seconds=float(kw.get("max_seconds", 0.0)),
                  prefix=kw["prefix"], meta_json=json.dumps(kw.get("meta") or {}))


def _expand_out(g, node):
    return IO.NodeOutput(node.out(0), node.out(1), node.out(2), node.out(3), expand=g.finalize())


# ---------------------------------------------------------------- utility nodes

class SoundstageAudioClip(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="SoundstageAudioClip",
            display_name="Soundstage · Audio → Cut Clip",
            category="Soundstage/Audio",
            search_aliases=["audio clip", "place audio", "timeline audio", "wav"],
            description="Turn any AUDIO into a Cut timeline clip: cleans it (optional silence trim, peak "
                        "normalise), writes a 48 kHz / 24-bit WAV to output/soundstage_audio/<shot_id>/ and "
                        "outputs the clip JSON for the Cut tab's audio list.",
            inputs=[
                IO.Audio.Input("audio"),
                IO.String.Input("label", default="", tooltip="Clip name on the timeline (default: file name)."),
                *_placement_inputs("FX1")[:5],
                IO.Boolean.Input("trim_silence", default=False, optional=True,
                                 tooltip="Cut dead lead/tail below -45 dBFS, keeping 150 ms."),
                IO.Float.Input("normalize_db", default=-3.0, min=-60.0, max=0.0, step=0.5, optional=True,
                               tooltip="Peak-normalise to this level. 0 = leave the level alone."),
                IO.Float.Input("max_seconds", default=0.0, min=0.0, max=3600.0, step=0.01, optional=True,
                               advanced=True, tooltip="Trim to this length (0 = keep all)."),
                IO.String.Input("prefix", default="clip", optional=True, advanced=True),
                IO.String.Input("meta_json", default="{}", optional=True, advanced=True, multiline=True),
            ],
            outputs=CLIP_OUTPUTS,
        )

    @classmethod
    def execute(cls, audio, label="", shot_id="shot1", track="FX1", start_frame=0, fps=24.0, gain_db=0.0,
                trim_silence=False, normalize_db=-3.0, max_seconds=0.0, prefix="clip", meta_json="{}"):
        x, sr = audio_to_np(audio)
        try:
            meta = json.loads(meta_json or "{}")
        except json.JSONDecodeError:
            meta = {"note": meta_json}
        y, clip = _finish(x, sr, prefix=prefix or label or "clip", shot_id=shot_id, track=track, fps=fps,
                          start_frame=start_frame, gain_db=gain_db, trim=trim_silence,
                          normalize_db=normalize_db if normalize_db < 0 else None,
                          max_seconds=max_seconds or None, label=label, meta=meta)
        out = np_to_audio(y, C.SR)
        dur = len(y) / C.SR
        return IO.NodeOutput(out, C.dumps(clip), dur, clip["frames"],
                             ui={**ui.PreviewAudio(out, cls=cls).as_dict(), "text": [C.dumps(clip)]})


class SoundstageLatentNoiseMask(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="SoundstageLatentNoiseMask",
            display_name="Soundstage · Latent Noise Mask (value)",
            category="Soundstage/Audio",
            search_aliases=["audio latent mask", "frozen audio", "lip sync mask", "noise mask"],
            description="Set a uniform noise mask on a latent: 0 = keep it frozen, 1 = regenerate it. On an "
                        "LTX audio latent, 0.2-0.5 keeps the audio pathway open so mouths move (frozen-mouth fix).",
            inputs=[IO.Latent.Input("latent"),
                    IO.Float.Input("value", default=0.3, min=0.0, max=1.0, step=0.01)],
            outputs=[IO.Latent.Output("out_latent", display_name="latent")],
        )

    @classmethod
    def execute(cls, latent, value=0.3):
        out = dict(latent)
        s = latent["samples"]
        out["noise_mask"] = torch.full(s.shape, float(value), dtype=torch.float32, device=s.device)
        return IO.NodeOutput(out)


def _resolve_mix_path(path, shot_id):
    """A WAV path, or a Cut export audio/index.json (+ shot_id) -> the shot's mixdown WAV."""
    p = os.path.expanduser(path.strip())
    if not os.path.isabs(p):
        p = os.path.join(folder_paths.get_output_directory(), p)
    if p.endswith(".json"):
        idx = json.load(open(p, encoding="utf-8"))
        shots = idx.get("shots") or []
        hit = next((s for s in shots if str(s.get("shot_id")) == str(shot_id)), None) or (shots[0] if shots else None)
        if hit is None:
            raise ValueError(f"Soundstage: {p} lists no shot mixdowns.")
        p = hit.get("path") or os.path.join(os.path.dirname(os.path.dirname(p)), hit["file"])
    if not os.path.exists(p):
        raise ValueError(f"Soundstage: audio file not found: {p}")
    return p


class SoundstageAudioFit(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="SoundstageAudioFit",
            display_name="Soundstage · Fit Audio to Shot",
            category="Soundstage/Audio",
            search_aliases=["shot audio", "mixdown", "pad audio", "trim audio", "load wav"],
            description="The shot's soundtrack: AUDIO, a WAV path, or a Cut export audio/index.json + shot id, "
                        "trimmed/padded so sample 0 is frame 0 and it runs exactly frames / fps. 48 kHz stereo.",
            inputs=[IO.Audio.Input("audio", optional=True),
                    IO.String.Input("path", default="", optional=True,
                                    tooltip="WAV path, or the Cut export's audio/index.json (picks shot_id)."),
                    IO.String.Input("shot_id", default="", optional=True),
                    IO.Int.Input("frames", default=97, min=1, max=100000),
                    IO.Float.Input("fps", default=24.0, min=1.0, max=120.0, step=0.001),
                    IO.Float.Input("offset_s", default=0.0, min=-3600.0, max=3600.0, step=0.001, optional=True,
                                   tooltip="Positive = start later in the file (slip).")],
            outputs=[IO.Audio.Output("out_audio", display_name="audio")],
        )

    @classmethod
    def execute(cls, frames, fps, audio=None, path="", shot_id="", offset_s=0.0):
        if audio is not None:
            x, sr = audio_to_np(audio)
        elif path:
            x, sr = C.read_wav(_resolve_mix_path(path, shot_id))
        else:
            raise ValueError("Soundstage Fit Audio: connect audio or give a WAV / Cut index.json path.")
        x = C.to_channels(C.resample(x, sr, C.SR), 2)
        y = C.fit_to_frames(x, C.SR, frames, fps, offset_s)
        return IO.NodeOutput(np_to_audio(y, C.SR))


# ---------------------------------------------------------------- generators

class SoundstageDialogue(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="SoundstageDialogue",
            display_name="Soundstage · Dialogue Line",
            category="Soundstage/Audio",
            search_aliases=["tts", "text to speech", "dialogue", "voice", "line", "chatterbox", "elevenlabs", "adr"],
            description="Speak one line for one character. Default Chatterbox (open, local, watermarked). "
                        "(Stage directions in parentheses) are dropped; [laugh] / [sigh] tags pass through. "
                        "Returns the trimmed line as AUDIO and a DX clip for the Cut.",
            inputs=[
                IO.String.Input("line", multiline=True, default=""),
                IO.String.Input("character", default="CHARACTER", tooltip="Character name (clip label + meta)."),
                _engine_input("dialogue", "TTS model. Open weights first; partner [API] = ElevenLabs on your "
                                          "Comfy credits."),
                _voice_input(),
                *_placement_inputs("DX1"),
            ],
            outputs=CLIP_OUTPUTS, hidden=HIDDEN, enable_expand=True,
        )

    @classmethod
    def execute(cls, line, character, engine, shot_id, track, start_frame, fps, seed, gain_db=0.0, voice=None):
        text = PR.dialogue_text(line)
        if not text:
            raise ValueError("Soundstage Dialogue: the line is empty.")
        e, params = _pick_engine("dialogue", engine)
        prefix = f"{C.slug(character, 'dx')}_line"
        meta = {"kind": "dialogue", "character": character, "line": text, "engine": e["label"],
                "voice": V.public(voice) if voice else ("chatterbox built-in" if e["kind"] == "inproc"
                                                        else params.get("preset_voice"))}
        place = dict(shot_id=shot_id, track=track, fps=fps, start_frame=start_frame, gain_db=gain_db,
                     trim=True, normalize_db=-3.0, label=f"{character}: {text[:40]}", prefix=prefix, meta=meta)
        if e["key"] == "chatterbox":
            import comfy.model_management as mm
            from .audio import tts
            dev = mm.get_torch_device()
            mm.free_memory(4 * 1024 ** 3, dev)
            t0 = time.time()
            try:
                wav, sr = tts.speak(text, dev, ref_path=voice["path"] if voice else None, seed=seed,
                                    **{k: params[k] for k in ("exaggeration", "cfg_weight", "temperature") if k in params})
            finally:
                tts.offload()
                mm.soft_empty_cache()
            meta["gen_s"] = round(time.time() - t0, 2)
            y, clip = _finish(wav, sr, **{k: v for k, v in place.items() if k != "prefix"}, prefix=prefix)
            out = np_to_audio(y, C.SR)
            return IO.NodeOutput(out, C.dumps(clip), len(y) / C.SR, clip["frames"],
                                 ui={**ui.PreviewAudio(out, cls=cls).as_dict(), "text": [C.dumps(clip)]})
        _check_api_auth(e, cls.hidden)
        g = GraphBuilder()
        link = G.elevenlabs_tts(g, text, seed, params, clone_audio=_voice_ref_link(g, voice))
        return _expand_out(g, _clip_node(g, link, **place))


class SoundstageSFX(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="SoundstageSFX",
            display_name="Soundstage · Sound Effect",
            category="Soundstage/Audio",
            search_aliases=["sfx", "sound effect", "foley", "video to audio", "v2a", "footsteps", "door"],
            description="One sound event per clip. Text → effect, or connect a clip's frames for foley synced to "
                        "the picture (video-to-audio). Default LTX-2.5 audio (open, local). The prompt is cleaned "
                        "of animal/voice words that leak into effects; warnings show on the node. Partner: ElevenLabs SFX.",
            inputs=[
                IO.String.Input("prompt", multiline=True, default="",
                                tooltip="One event: 'single heavy wooden door slams shut in a stone hallway'."),
                _engine_input("sfx", "Effects engine. With frames connected the engine runs video-to-audio."),
                _media(IO.Image, "frames", "Optional: the shot's frames. Foley is generated in sync with them."),
                IO.Int.Input("video_frames", default=97, min=9, max=1000, optional=True,
                             tooltip="Frame count of the connected frames (the stage's `frames` output)."),
                IO.Float.Input("duration_s", default=2.0, min=0.2, max=30.0, step=0.1,
                               tooltip="Text mode length. Video mode uses the clip length."),
                IO.Boolean.Input("guard_prompt", default=True, optional=True,
                                 tooltip="Swap leak words and add 'No animals, no voices, no music.'"),
                IO.String.Input("allow_words", default="", optional=True, advanced=True,
                                tooltip="Comma list of words to keep (e.g. 'dog' when you want a dog)."),
                *_placement_inputs("FX1"),
            ],
            outputs=CLIP_OUTPUTS, hidden=HIDDEN, enable_expand=True,
        )

    @classmethod
    def check_lazy_status(cls, **kwargs):
        return []

    @classmethod
    def execute(cls, prompt, engine, duration_s, shot_id, track, start_frame, fps, seed, frames=None,
                video_frames=97, guard_prompt=True, allow_words="", gain_db=0.0):
        e, params = _pick_engine("sfx", engine)
        allow = [w.strip() for w in allow_words.split(",") if w.strip()]
        text, warnings = PR.sfx_prompt(prompt, guard=guard_prompt, allow=allow)
        if not prompt.strip() and frames is None:
            raise ValueError("Soundstage SFX: write a prompt or connect frames.")
        video = frames is not None
        seconds = video_frames / fps if video else duration_s
        meta = {"kind": "sfx", "prompt": prompt, "sent_prompt": text, "engine": e["label"],
                "mode": "video-to-audio" if video else "text-to-audio", "warnings": warnings}
        place = dict(shot_id=shot_id, track=track, fps=fps, start_frame=start_frame, gain_db=gain_db,
                     normalize_db=-3.0, max_seconds=seconds, label=(prompt or "foley")[:40],
                     prefix=C.slug((prompt or "foley")[:24], "sfx"), meta=meta)
        _check_api_auth(e, cls.hidden)
        g = GraphBuilder()
        if e["key"] == "ltx_t2a":
            w = _ltx_weights()
            if w is None:
                raise ValueError("LTX-2.5 audio needs the LTX-2.5 transformer, Gemma text encoder and audio VAE.")
            link = (G.ltx_video_to_audio(g, w, frames, video_frames, fps, text, seed) if video
                    else G.ltx_text_to_audio(g, w, text, seconds, seed))
            if video:
                place["max_seconds"] = G.ltx_frames(video_frames) / fps
        else:
            if video:
                raise ValueError(f"{e['label']} has no video-to-audio mode. Pick LTX-2.5 audio.")
            link = G.elevenlabs_sfx(g, text, seconds, params)
        return _expand_out(g, _clip_node(g, link, **place))


class SoundstageMusic(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="SoundstageMusic",
            display_name="Soundstage · Music Cue",
            category="Soundstage/Audio",
            search_aliases=["music", "score", "cue", "soundtrack", "text to music"],
            description="A score cue from a brief: genre, mood, tempo, length, instruments. Default LTX-2.5 "
                        "audio (open, local; ElevenLabs has no music node in Comfy yet). MX clip for the Cut.",
            inputs=[
                IO.String.Input("genre", default="neo-noir"),
                IO.String.Input("mood", default="tense, restrained"),
                IO.Int.Input("tempo_bpm", default=90, min=0, max=240, tooltip="0 = let the model choose."),
                IO.Float.Input("length_s", default=8.0, min=1.0, max=360.0, step=0.5),
                IO.String.Input("instruments", default="low strings, soft pulse synth"),
                IO.String.Input("notes", default="", multiline=True, optional=True,
                                tooltip="Extra direction appended to the brief."),
                _engine_input("music", "Music engine (LTX-2.5 audio)."),
                *_placement_inputs("MX1"),
            ],
            outputs=CLIP_OUTPUTS, hidden=HIDDEN, enable_expand=True,
        )

    @classmethod
    def execute(cls, genre, mood, tempo_bpm, length_s, instruments, engine, shot_id, track, start_frame, fps,
                seed, notes="", gain_db=0.0):
        e, params = _pick_engine("music", engine)
        brief = PR.music_brief(genre, mood, tempo_bpm, length_s, instruments, notes)
        meta = {"kind": "music", "brief": brief, "engine": e["label"], "tempo_bpm": tempo_bpm}
        place = dict(shot_id=shot_id, track=track, fps=fps, start_frame=start_frame, gain_db=gain_db,
                     normalize_db=-3.0, max_seconds=length_s, label=f"{mood} {genre} cue"[:40],
                     prefix=C.slug(f"cue_{genre}"[:24], "cue"), meta=meta)
        _check_api_auth(e, cls.hidden)
        g = GraphBuilder()
        if e["key"] == "ltx_t2a":
            w = _ltx_weights()
            if w is None:
                raise ValueError("LTX-2.5 audio needs the LTX-2.5 transformer, Gemma text encoder and audio VAE.")
            link = G.ltx_text_to_audio(g, w, brief, length_s, seed, negative="speech, talking, voice, noise")
        else:
            raise ValueError(f"Soundstage Music: no builder for {e['label']}.")
        return _expand_out(g, _clip_node(g, link, **place))


class SoundstageAudioQC(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="SoundstageAudioQC",
            display_name="Soundstage · Audio QC",
            category="Soundstage/Audio",
            search_aliases=["audio qc", "classifier", "audioset", "ast", "whisper", "check sound"],
            description="Listen before delivering: AudioSet classifier (AST) flags clips whose top labels do not "
                        "match the prompt or contain dogs / voices / music where they should not; Whisper checks "
                        "a dialogue line's words. Local models only; without them, basic level checks.",
            inputs=[
                IO.Audio.Input("audio"),
                IO.Combo.Input("kind", options=["auto", "sfx", "dialogue", "music"], default="auto",
                               tooltip="auto = read it from clip_json meta.kind."),
                IO.String.Input("expect", multiline=True, default="", optional=True,
                                tooltip="What should be heard (the prompt or the line). Empty = from clip_json."),
                IO.String.Input("clip_json", default="", optional=True, multiline=True,
                                tooltip="Clip JSON from a generator; the QC report is added to meta.qc."),
                IO.Boolean.Input("fail_on_issue", default=False, optional=True,
                                 tooltip="Stop the run (error) when the clip fails QC."),
            ],
            outputs=[IO.Audio.Output("out_audio", display_name="audio"), IO.Boolean.Output("out_passed", display_name="passed"),
                     IO.String.Output("out_report", display_name="report"), IO.String.Output("out_clip_json", display_name="clip_json")],
        )

    @classmethod
    def execute(cls, audio, kind="auto", expect="", clip_json="", fail_on_issue=False):
        from .audio import qc
        import comfy.model_management as mm
        clip = json.loads(clip_json) if clip_json and clip_json.strip() else None
        meta = (clip or {}).get("meta") or {}
        k = kind if kind != "auto" else meta.get("kind", "sfx")
        exp = expect or meta.get("line") or meta.get("prompt") or meta.get("brief") or ""
        x, sr = audio_to_np(audio)
        rep = qc.check(x, sr, k, prompt=exp, line=exp, device=mm.get_torch_device())
        if clip is not None:
            clip.setdefault("meta", {})["qc"] = {k2: rep[k2] for k2 in ("pass", "verified", "issues", "top_labels")}
        text = ("PASS" if rep["pass"] else "FAIL") + ("" if rep["verified"] else " (unverified)") + "\n" + \
            "\n".join(["- " + i for i in rep["issues"]] + ["· " + n for n in rep["notes"]])
        if fail_on_issue and not rep["pass"]:
            raise ValueError("Soundstage Audio QC failed:\n" + text)
        return IO.NodeOutput(audio, bool(rep["pass"]), json.dumps(rep), json.dumps(clip) if clip else "",
                             ui={"text": [text]})

# ---------------------------------------------------------------- character voices

class SoundstageVoice(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="SoundstageVoice",
            display_name="Soundstage · Character Voice",
            category="Soundstage/Audio",
            search_aliases=["voice clone", "character voice", "voice library", "reference voice", "speaker"],
            description="A reusable character voice. Connect a 5-10 s reference recording, name it and tick "
                        "consent to save it (user/soundstage/voices/<name>.json + .wav); leave the reference "
                        "empty to load a saved voice by name. Feed it to Dialogue Line or Voice Change so the "
                        "character sounds the same in every shot. ONLY your own voice or one you have the "
                        "rights to; never a real third party without their consent.",
            inputs=[
                IO.String.Input("name", default="", tooltip="Voice name, e.g. PIP. Saved voices: see the list "
                                                            "in the node output text."),
                IO.Audio.Input("reference", optional=True,
                               tooltip="5-10 s of clean speech by the voice's owner. Connect to create/update."),
                IO.Boolean.Input("consent", default=False, optional=True,
                                 tooltip=V.CONSENT_TEXT),
                IO.String.Input("voice_owner", default="", optional=True,
                                tooltip="Whose voice this is: 'me', or the consenting actor's name."),
                IO.String.Input("character", default="", optional=True),
                IO.String.Input("notes", default="", optional=True, multiline=True,
                                tooltip="e.g. where the permission is recorded."),
            ],
            outputs=[Voice.Output("out_voice", display_name="voice"), IO.Audio.Output("out_reference", display_name="reference"),
                     IO.String.Output("out_voice_json", display_name="voice_json")],
        )

    @classmethod
    def execute(cls, name, reference=None, consent=False, voice_owner="", character="", notes=""):
        ud = _user_dir()
        if reference is not None:
            x, sr = audio_to_np(reference)
            v = V.save_voice(ud, name, x, sr, consent=consent, owner=voice_owner, character=character, notes=notes)
            action = "saved"
        else:
            v = V.load_voice(ud, name)
            action = "loaded"
        y, sr = C.read_wav(v["path"])
        info = {k: v[k] for k in ("name", "character", "duration_s", "consent")}
        text = (f"Voice '{v['name']}' {action} ({v['duration_s']} s, owner: {v['consent']['owner']}).\n"
                f"Saved voices: {', '.join(V.list_voices(ud))}")
        return IO.NodeOutput(v, np_to_audio(y, sr), json.dumps(info), ui={"text": [text]})

    @classmethod
    def fingerprint_inputs(cls, name, reference=None, consent=False, voice_owner="", character="", notes=""):
        if reference is not None:
            import hashlib
            wf = reference["waveform"]
            h = hashlib.sha1(np.ascontiguousarray(wf.detach().cpu().numpy() if isinstance(wf, torch.Tensor) else wf)
                             .tobytes()).hexdigest()
            return f"{name}:{h}:{consent}:{voice_owner}:{character}:{notes}"
        try:  # a saved voice re-runs when its files change
            p = os.path.join(V.voice_dir(_user_dir()), V.safe_name(name) + ".json")
            return f"{name}:{os.path.getmtime(p)}"
        except (OSError, ValueError):
            return name


class SoundstageVoiceChange(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="SoundstageVoiceChange",
            display_name="Soundstage · Voice Change (speech-to-speech)",
            category="Soundstage/Audio",
            search_aliases=["voice change", "speech to speech", "sts", "voice conversion", "revoice", "adr"],
            description="Act the line yourself, with the timing and emotion you want, then re-voice it as the "
                        "character. Timing is kept sample for sample, so lip sync from Shot from Sound holds. "
                        "Default Chatterbox VC (local); partner ElevenLabs Speech-to-Speech.",
            inputs=[
                _media(IO.Audio, "performance", "Your read of the line (only your own voice or one you have rights to)."),
                _voice_input(),
                IO.String.Input("character", default="CHARACTER"),
                IO.String.Input("line", default="", optional=True, multiline=True,
                                tooltip="What is said (for the clip label and Whisper QC)."),
                _engine_input("voice_change", "Voice-change model. Open weights first; partner [API] = ElevenLabs."),
                *_placement_inputs("DX1"),
            ],
            outputs=CLIP_OUTPUTS, hidden=HIDDEN, enable_expand=True,
        )

    @classmethod
    def check_lazy_status(cls, **kwargs):
        return []

    @classmethod
    def execute(cls, character, engine, shot_id, track, start_frame, fps, seed, performance=None, voice=None,
                line="", gain_db=0.0):
        if performance is None:
            raise ValueError("Soundstage Voice Change: connect the performance audio.")
        e, params = _pick_engine("voice_change", engine)
        _check_api_auth(e, cls.hidden)
        meta = {"kind": "dialogue", "character": character, "line": PR.dialogue_text(line), "engine": e["label"],
                "mode": "voice change", "voice": V.public(voice) if voice else "built-in / preset"}
        place = dict(shot_id=shot_id, track=track, fps=fps, start_frame=start_frame, gain_db=gain_db, trim=False,
                     normalize_db=-3.0, label=f"{character}: {(line or 'voice change')[:40]}",
                     prefix=f"{C.slug(character, 'dx')}_vc", meta=meta)
        g = GraphBuilder()
        if e["key"] == "chatterbox_vc":
            link = g.node("SoundstageChatterboxVC", audio=performance, voice_name=voice["name"] if voice else "").out(0)
        else:
            link = G.elevenlabs_sts(g, performance, seed, params, clone_audio=_voice_ref_link(g, voice))
        return _expand_out(g, _clip_node(g, link, **place))


class SoundstageChatterboxVC(IO.ComfyNode):
    """Internal step of Voice Change (also usable alone): Chatterbox speech-to-speech, same length out."""

    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="SoundstageChatterboxVC",
            display_name="Soundstage · Chatterbox VC (step)",
            category="Soundstage/Audio/steps",
            description="Chatterbox speech-to-speech to a saved Character Voice (or the built-in voice). Output is "
                        "padded/trimmed to the input length so the timing is unchanged.",
            inputs=[IO.Audio.Input("audio"), IO.String.Input("voice_name", default="", optional=True)],
            outputs=[IO.Audio.Output("out_audio", display_name="audio")],
        )

    @classmethod
    def execute(cls, audio, voice_name=""):
        import comfy.model_management as mm
        from .audio import tts
        ref = V.load_voice(_user_dir(), voice_name)["path"] if voice_name else None
        x, sr = audio_to_np(audio)
        dev = mm.get_torch_device()
        mm.free_memory(4 * 1024 ** 3, dev)
        try:
            y, ysr = tts.convert(x.mean(axis=1), sr, dev, ref_path=ref)
        finally:
            tts.offload()
            mm.soft_empty_cache()
        y = C.fit_length(C.resample(y, ysr, C.SR), int(round(len(x) / sr * C.SR)))  # keep the performance's timing
        return IO.NodeOutput(np_to_audio(y, C.SR))


# ---------------------------------------------------------------- App: one node for the shot's sound

APP_GAINS = {"dialogue": 0.0, "sfx": -6.0, "music": -14.0}


def _engine_defaults(dept, label):
    e = E.find(dept, label) or E.ENGINES[dept][0]
    return {"engine": e["label"], **{f"engine.{p['id']}": p["default"] for p in e["params"]}}


class SoundstageShotSound(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        dx = [e["label"] for e in _engines("dialogue")]
        return IO.Schema(
            node_id="SoundstageShotSound",
            display_name="Soundstage · Shot Sound (App)",
            category="Soundstage/Audio",
            search_aliases=["shot sound", "app audio", "sound for the shot", "mix"],
            description="The App's sound department in one node: one dialogue line, one SFX, an optional music "
                        "mood, mixed to the shot length (DX 0 dB, FX -6 dB, MX -14 dB). Blank fields are "
                        "skipped and never run; all blank = no sound output at all.",
            inputs=[
                IO.String.Input("line", multiline=True, default="", tooltip="Dialogue line. Blank = no dialogue."),
                IO.String.Input("character", default="", tooltip="Who speaks (label)."),
                IO.String.Input("voice", default="", tooltip="Saved Character Voice name. Blank = built-in voice."),
                IO.Combo.Input("dialogue_engine", options=dx, default=dx[0]),
                IO.String.Input("sfx_prompt", multiline=True, default="",
                                tooltip="One sound event (LTX-2.5 audio). Blank = no SFX."),
                IO.String.Input("music_mood", default="", tooltip="e.g. 'tense neo-noir'. Blank = no music."),
                IO.Int.Input("frames", default=97, min=1, max=100000, force_input=True),
                IO.Float.Input("fps", default=24.0, min=1.0, max=120.0, force_input=True),
                IO.Int.Input("dialogue_start_frame", default=6, min=0, max=100000, optional=True, advanced=True),
                IO.Int.Input("seed", default=0, min=0, max=0xFFFFFFFFFFFFFFFF),
            ],
            outputs=[IO.Audio.Output("out_mix", display_name="mix"), IO.String.Output("out_mix_json", display_name="mix_json")],
            enable_expand=True,
        )

    @classmethod
    def execute(cls, line, character, voice, dialogue_engine, sfx_prompt, music_mood, frames, fps, seed,
                dialogue_start_frame=6):
        line, sfx_prompt, music_mood = (line or "").strip(), (sfx_prompt or "").strip(), (music_mood or "").strip()
        if not (line or sfx_prompt or music_mood):
            return IO.NodeOutput(ExecutionBlocker(None), ExecutionBlocker(None))
        seconds = frames / float(fps)
        common = dict(shot_id="app_shot", fps=float(fps), seed=int(seed))
        g = GraphBuilder()
        clips = []
        if line:
            kw = dict(line=line, character=character or "CHARACTER", track="DX1",
                      start_frame=int(dialogue_start_frame), gain_db=APP_GAINS["dialogue"], **common,
                      **_engine_defaults("dialogue", dialogue_engine))
            if voice.strip():
                kw["voice"] = g.node("SoundstageVoice", name=voice.strip()).out(0)
            clips.append(g.node("SoundstageDialogue", **kw).out(1))
        if sfx_prompt:
            clips.append(g.node("SoundstageSFX", prompt=sfx_prompt, duration_s=round(min(30.0, seconds), 2),
                                track="FX1", start_frame=0, gain_db=APP_GAINS["sfx"],
                                **common, **_engine_defaults("sfx", "ltx_t2a")).out(1))
        if music_mood:
            clips.append(g.node("SoundstageMusic", genre="", mood=music_mood, tempo_bpm=0,
                                length_s=round(max(1.0, seconds), 2), instruments="", track="MX1", start_frame=0,
                                gain_db=APP_GAINS["music"], **common, **_engine_defaults("music", "ltx_t2a")).out(1))
        mix = g.node("SoundstageMixClips", frames=int(frames), fps=float(fps),
                     **{f"clip_{i + 1}": c for i, c in enumerate(clips)})
        return IO.NodeOutput(mix.out(0), mix.out(1), expand=g.finalize())


class SoundstageMixClips(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="SoundstageMixClips",
            display_name="Soundstage · Mix Clips to Shot",
            category="Soundstage/Audio",
            search_aliases=["mix", "mixdown", "place clips"],
            description="Mix up to 4 Cut clips (clip_json) into one shot-length track: each placed at its "
                        "start_frame with its gain and fades; frame 0 = sample 0, exactly frames / fps long. "
                        "Peak-limited to -1 dBFS. Also writes the mix WAV + a Cut-style JSON.",
            inputs=[IO.String.Input(f"clip_{i}", default="", optional=True, force_input=True) for i in range(1, 5)] + [
                IO.Int.Input("frames", default=97, min=1, max=100000),
                IO.Float.Input("fps", default=24.0, min=1.0, max=120.0, step=0.001)],
            outputs=[IO.Audio.Output("out_audio", display_name="audio"), IO.String.Output("out_json", display_name="mix_json")],
        )

    @classmethod
    def execute(cls, frames, fps, **clips):
        used = [json.loads(clips[k]) for k in sorted(clips) if clips[k]]
        mix = C.mix_clips(used, folder_paths.get_output_directory(), frames, fps)
        rel, full = _shot_dir("app_shot")
        name = C.unique_id("shot_mix", full)
        C.write_wav(os.path.join(full, name + ".wav"), mix)
        info = {"fps": fps, "frames": frames, "mix": os.path.join(rel, name + ".wav").replace(os.sep, "/"),
                "peak_dbfs": C.peak_dbfs(mix), "audio": used, "audio_tracks": C.DEFAULT_AUDIO_TRACKS}
        return IO.NodeOutput(np_to_audio(mix, C.SR), json.dumps(info), ui={"text": [
            "Shot mix: " + ", ".join(f"{c['meta'].get('track_name')} {c['label']}" for c in used)]})


class SoundstageWhen(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        t = IO.MatchType.Template("when")
        return IO.Schema(
            node_id="SoundstageWhen",
            display_name="Soundstage · On/Off Switch",
            category="Soundstage/Audio",
            search_aliases=["toggle", "switch", "enable", "bypass branch"],
            description="Lazy on/off: when off, nothing upstream of `value` runs and the output is skipped.",
            inputs=[IO.Boolean.Input("enabled", default=False), IO.MatchType.Input("value", template=t, lazy=True)],
            outputs=[IO.MatchType.Output(template=t, display_name="value")],
        )

    @classmethod
    def check_lazy_status(cls, enabled, value=None):
        return ["value"] if enabled and value is None else []

    @classmethod
    def execute(cls, enabled, value=None):
        if not enabled or value is None:
            return IO.NodeOutput(ExecutionBlocker(None))
        return IO.NodeOutput(value)


# ---------------------------------------------------------------- audio-driven LTX

class SoundstageAudioDrivenShot(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="SoundstageAudioDrivenShot",
            display_name="Soundstage · Shot from Sound (LTX-2.5)",
            category="Soundstage/Audio",
            search_aliases=["audio driven", "audio to video", "lip sync", "a2v", "sound sync", "ltx audio"],
            description="Render the shot with LTX-2.5 conditioned on the edited sound, so picture lands on the "
                        "footsteps, hits and words. With control_video (stage clay) it is Layout-To-Render; "
                        "otherwise image/text-to-video. The supplied audio is the final soundtrack.",
            inputs=[
                _media(IO.Audio, "audio", "The shot's sound (e.g. Fit Audio to Shot, or any AUDIO)."),
                IO.String.Input("mix_path", default="", optional=True,
                                tooltip="Instead of audio: a WAV path or the Cut export's audio/index.json."),
                IO.String.Input("shot_id", default="", optional=True, tooltip="Shot to pick from index.json."),
                IO.String.Input("prompt", multiline=True, default=""),
                IO.String.Input("negative", multiline=True, default="", optional=True, advanced=True),
                _media(IO.Image, "control_video", "Stage clay pass → Layout-To-Render."),
                _media(IO.Image, "first_frame", "Look still / start frame."),
                IO.Int.Input("width", default=1920, min=256, max=4096, step=64),
                IO.Int.Input("height", default=1088, min=256, max=4096, step=64),
                IO.Int.Input("frames", default=97, min=9, max=1000, tooltip="Snapped down to 8k+1."),
                IO.Float.Input("fps", default=24.0, min=1.0, max=60.0, step=0.001),
                IO.Float.Input("audio_mask", default=0.3, min=0.0, max=1.0, step=0.01,
                               tooltip="Noise mask on the audio latent. 0 = frozen (best for effects); "
                                       "0.2-0.5 for dialogue so lips move (fixes LTX's frozen mouth)."),
                IO.Float.Input("offset_s", default=0.0, min=-60.0, max=60.0, step=0.001, optional=True,
                               tooltip="Slip the audio: positive starts later in the file."),
                IO.Combo.Input("quality", options=["final", "draft"], default="final",
                               tooltip="draft = stage 1 only (half size, ~3x faster)."),
                IO.Combo.Input("soundtrack", options=["supplied", "ltx"], default="supplied", optional=True,
                               advanced=True, tooltip="supplied = your audio on the video (default); ltx = the "
                                                       "model's re-decoded audio."),
                IO.Boolean.Input("ref_tokens", default=False, optional=True, advanced=True,
                                 tooltip="Also attach the audio as reference tokens (LTXVSetAudioRefTokens)."),
                IO.Int.Input("seed", default=0, min=0, max=0xFFFFFFFFFFFFFFFF, control_after_generate=True),
            ],
            outputs=[IO.Video.Output("out_video", display_name="video"), IO.Image.Output("out_frames", display_name="frames"),
                     IO.Audio.Output("out_audio", display_name="audio")],
            enable_expand=True,
        )

    @classmethod
    def check_lazy_status(cls, **kwargs):
        return []

    @classmethod
    def execute(cls, prompt, width, height, frames, fps, audio_mask, quality, seed, audio=None, mix_path="",
                shot_id="", negative="", control_video=None, first_frame=None, offset_s=0.0, soundtrack="supplied",
                ref_tokens=False):
        w = E.resolve_weights({"weights": E.LTX_WEIGHTS}, _list_files)
        need = ["unet", "text_encoder", "vae", "audio_vae"] + (["upscaler"] if quality == "final" else [])
        miss = [r for r in need if not w.get(r)]
        if miss:
            raise ValueError("Soundstage Shot from Sound: missing LTX-2.5 weights: " + ", ".join(miss))
        g = GraphBuilder()
        if audio is None:
            if not mix_path:
                raise ValueError("Soundstage Shot from Sound: connect audio or set mix_path.")
            audio = g.node("SoundstageAudioFit", path=mix_path, shot_id=shot_id, frames=G.ltx_frames(frames),
                           fps=float(fps)).out(0)
        outs = G.audio_driven_shot(g, w, {
            "prompt": prompt, "negative": negative, "seed": seed, "width": width, "height": height, "frames": frames,
            "fps": fps, "control": control_video, "first": first_frame, "audio": audio, "offset_s": offset_s,
            "audio_mask": audio_mask, "quality": quality, "soundtrack": soundtrack, "ref_tokens": ref_tokens})
        return IO.NodeOutput(outs["video"], outs["images"], outs["audio"], expand=g.finalize())


NODES = [SoundstageShotSound, SoundstageMixClips, SoundstageWhen, SoundstageVoice, SoundstageVoiceChange, SoundstageChatterboxVC, SoundstageDialogue, SoundstageSFX, SoundstageMusic, SoundstageAudioQC, SoundstageAudioDrivenShot,
         SoundstageAudioClip, SoundstageAudioFit, SoundstageLatentNoiseMask]
