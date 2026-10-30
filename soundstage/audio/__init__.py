"""Soundstage audio department: dialogue, effects, music, QC and audio-driven LTX renders.

clip.py     pure numpy: Cut-contract clip JSON, DSP (trim, normalise, fades, fit), WAV I/O, onsets
prompts.py  prompt hygiene (SFX leak words, one event per generation) and music briefs
engines.py  stage-aware engine lists per department (open weights first, partner nodes as [API])
graphs.py   GraphBuilder subgraphs: LTX-2.5 text-to-audio, video-to-audio, audio-driven shot, partner nodes
tts.py      Chatterbox loader from local weights (no download), runs inside ComfyUI
qc.py       AudioSet (AST) classifier and Whisper checks with a no-model fallback
None of clip.py / prompts.py / engines.py / graphs.py import ComfyUI, so tests run anywhere.
"""
