# Soundstage · Audio department

Generate dialogue, effects and music as clips that drop straight onto the Cut tab's audio tracks, check
them by ear-equivalent (AudioSet classifier / Whisper), then render the shot with LTX-2.5 **driven by the
edited sound**, so footsteps land on feet and words on mouths. The supplied audio stays the soundtrack.

Code: `soundstage/nodes_audio.py` (nodes), `soundstage/audio/` (clip/DSP, prompts, engines, graphs, tts, qc).
Tests: `cd tests && python -m pytest test_audio_clip.py test_audio_graphs.py` (no ComfyUI/GPU needed).

## Tracks

| Track | Cut lane | Use |
|---|---|---|
| DX1, DX2 | A1, A2 | dialogue (one character per lane is easiest to mix) |
| FX1, FX2 | A3, A4 | effects: one event per clip (footsteps layer, door, impact…) |
| MX1, MX2 | A5, A6 | music cues |

Suggested `audio_tracks` for a project: `[{track:1,name:"DX1"},{track:2,name:"DX2"},{track:3,name:"FX1"},
{track:4,name:"FX2"},{track:5,name:"MX1"},{track:6,name:"MX2"}]` (`soundstage.audio.clip.DEFAULT_AUDIO_TRACKS`).
The EDL writer then prints `TRACK FX1` etc. on each audio event.

## Clip JSON (= the Cut contract)

Every generator outputs `clip_json`, one entry for the Cut project's `audio` list
(`soundstage/cut/export.py normalize_audio`). All times are **frames** at the project fps:

```json
{"id": "door_001", "track": 4, "path": "soundstage_audio/walkin/door_001.wav",
 "start_frame": 0, "in": 0, "out": 49, "frames": 49, "gain_db": 0.0, "fade_in": 0, "fade_out": 0,
 "label": "glass door opens",
 "meta": {"kind": "sfx", "prompt": "...", "sent_prompt": "...", "engine": "LTX-2.5 audio · local [open · <$10M]",
          "shot_id": "walkin", "duration_s": 2.03, "peak_dbfs": -3.0, "rms_dbfs": -21.4, "sample_rate": 48000,
          "track_name": "FX2", "warnings": [], "qc": {"pass": true, "verified": true, "issues": [], "top_labels": [...]}}}
```

`path` is relative to the ComfyUI output folder, which `soundstage/cut/mix.py` resolves. Files are
48 kHz / 24-bit stereo WAV in `output/soundstage_audio/<shot_id>/`, never overwritten (`_001`, `_002`…).
`tests/test_audio_clip.py::test_clip_mixes_through_cut_mixdown` runs two generated clips through the
Cut's own `write_mixdown` and finds them at their frames in the shot mixdown.

## Nodes (category Soundstage/Audio)

| Node | In | Out |
|---|---|---|
| **Soundstage · Dialogue Line** `SoundstageDialogue` | line, character, engine (TTS model picker), optional `voice` (Character Voice), shot_id/track/start_frame/fps | AUDIO, clip_json, duration_s, frames |
| **Soundstage · Character Voice** `SoundstageVoice` | name; to create: `reference` (5-10 s), `consent` ✓, `voice_owner` | SOUNDSTAGE_VOICE, reference AUDIO, voice_json |
| **Soundstage · Voice Change (speech-to-speech)** `SoundstageVoiceChange` | `performance` (your read), optional `voice`, engine, line, placement | AUDIO (same length/timing), clip_json, … |
| **Soundstage · Sound Effect** `SoundstageSFX` | prompt (one event), engine, optional `frames` (+`video_frames`) for video-to-audio, duration_s | same |
| **Soundstage · Music Cue** `SoundstageMusic` | genre, mood, tempo_bpm, length_s, instruments, notes, engine | same |
| **Soundstage · Audio QC** `SoundstageAudioQC` | AUDIO, kind, expect, clip_json | AUDIO, passed, report, clip_json (+meta.qc) |
| **Soundstage · Shot from Sound (LTX-2.5)** `SoundstageAudioDrivenShot` | audio or mix_path(+shot_id), prompt, control_video, first_frame, size, frames, fps, audio_mask, quality | VIDEO, frames, AUDIO |
| Soundstage · Audio → Cut Clip `SoundstageAudioClip` | any AUDIO + placement | AUDIO, clip_json, … (also the last step of every generator) |
| Soundstage · Fit Audio to Shot `SoundstageAudioFit` | AUDIO, WAV path, or Cut `audio/index.json` + shot_id | AUDIO exactly frames/fps long, frame 0 = sample 0 |
| Soundstage · Latent Noise Mask `SoundstageLatentNoiseMask` | LATENT, value | LATENT with a uniform noise mask |

Engines are a stage-aware dropdown like the model router: open weights first and default, partner
nodes labelled **[API]** (your Comfy credits; hidden with `SOUNDSTAGE_OPEN_WEIGHTS_ONLY=1`), and only
engines whose nodes/weights/packages are present are listed. Local LTX and partner engines expand into
their real nodes at run time; Chatterbox runs in-process.

Prompt hygiene (SFX): words that name an animal or a voice summon one even as a metaphor ("the engine
barks" gave a real dog), so `bark/cough/growl/howl/roar/purr/scream…` are swapped for mechanical words and
`No animals, no voices, no music.` is appended (`guard_prompt`, `allow_words` to opt out). Prompts that
read like several events get a warning: multi-beat prompts collapse into one sound, so generate each
event and place them on FX1/FX2.

Dialogue: `(stage directions)` are dropped, Chatterbox `[laugh]`/`[sigh]` tags pass through, the line is
trimmed of dead lead/tail (150 ms kept) and peak-normalised to -3 dBFS.

### Dialogue engines (per Mike, 2026-10-28: Chatterbox or ElevenLabs, no new models)

| Engine | Controls | Voice |
|---|---|---|
| Chatterbox · local [open · MIT] (default) | exaggeration (emotion), cfg_weight (pace: ~0.3 slower), temperature | built-in, or a Character Voice zero-shot |
| ElevenLabs TTS · partner [API] (Comfy credits) | model eleven_v4 / v4_turbo / v3 / multilingual_v2, stability, speed (v3/multilingual), language | preset voice, or a Character Voice → Instant Voice Clone |

### Character voices and consent

`SoundstageVoice` saves `user/soundstage/voices/<name>.json` + `<name>.wav` (trimmed, 3-15 s, 48 kHz) so a
character sounds the same in every shot; leave `reference` empty to load by name. **Consent rule:** only
your own voice, or one you have the rights to (a consenting actor, a licensed or designed voice). Saving
needs the consent box ticked and `voice_owner` filled; the JSON stores owner, statement and date; loading
refuses a voice without a consent record; the voice's owner/date go into every clip's `meta.voice`. Never
ship or demo a clone of a real third party. Chatterbox clones zero-shot from the file; ElevenLabs makes
an Instant Voice Clone in the signed-in Comfy partner account (re-created per run when inputs change;
ComfyUI's cache reuses it otherwise).

### Voice change (directed performances)

Act the line yourself with the timing and emotion you want, then `SoundstageVoiceChange` re-voices it as
the character. The output is padded/trimmed to the input length, so the timing (and therefore lip sync in
Shot from Sound) holds. Engines: **Chatterbox VC** (local; the installed chatterbox package's S3Gen, no
extra weights; target = Character Voice or built-in) and **ElevenLabs Speech-to-Speech** [API]
(eleven_multilingual_sts_v2 / eleven_english_sts_v2, stability, similarity, optional noise removal).
Not installed and not used, per Mike: F5-TTS, IndexTTS-2, Kokoro, Dia, Seed-VC, RVC, OpenVoice (the pod has
only `vibevoice` 0.0.1 as a package, no weights; empty models/TTS/{CosyVoice,dramabox,higgs_audio_v3}).

## Inventory on the pod (2026-10-28) and licences

Installed and used:

| What | Where | Licence |
|---|---|---|
| Chatterbox (English) TTS, `chatterbox-tts` 0.1.7 | `models/TTS/chatterbox/English` (ve.pt, t3_cfg.pt, s3gen.safetensors, tokenizer.json, conds.pt) | MIT (Resemble AI), Perth watermark |
| LTX-2.5 22B distilled int8 + Gemma-4-12B int8 + video/audio VAE + x2 upscaler + Layout-To-Render IC-LoRA | `models/` (see MODELS.md) | LTX-2.x Community License: free incl. commercial below $10M revenue |
| LTX audio-only mode (`LTXVAudioOnlyModel`, ComfyUI-LTXVideo) | custom node | Apache-2.0 (node pack) |
| Whisper base (dialogue QC) | `models/whisper/whisper-base` | MIT (OpenAI) |
| ElevenLabs partner nodes (used): TextToSpeech, VoiceSelector, InstantVoiceClone, SpeechToSpeech, TextToSoundEffects (also present: TextToDialogue, AudioIsolation, SpeechToText) | comfy_api_nodes | ElevenLabs terms, billed to the Comfy account |
| Other partner audio nodes present but **not offered** (Mike: Chatterbox or ElevenLabs only): Fish Audio, Mirelo, Sonilo, MiniMax Music 3, HeyGen, ByteDance Seed Audio, VEED | comfy_api_nodes | n/a |

Present as nodes but **no weights on the pod** (Mike, 2026-10-28: none of these will be downloaded):

| Model | Core nodes | Weights licence |
|---|---|---|
| Stable Audio 3 Medium / Stable Audio Open | blueprints + `ConditioningStableAudio` | Stability AI Community License (free < $1M revenue) |
| ACE-Step 1.5 (music) | `TextEncodeAceStepAudio1.5`, blueprint | Apache-2.0 for ACE-Step 1.0; confirm 1.5 before use |
| MMAudio (video-to-audio) | `comfy/ldm/mmaudio` only, no loader nodes listed | code MIT; weights licence to confirm (trained on VGGSound etc.) |
| YuE2, MiniMax Music 3 local | `YuE2GenerateMusic`, `EmptyMiniMaxMusic3LatentAudio` | YuE Apache-2.0; MiniMax Music 3 licence conflicting (research/09) |
| HunyuanVideo-Foley | none | Tencent Hunyuan Community License (excludes EU/UK/KR) |
| AST AudioSet classifier `MIT/ast-finetuned-audioset-10-10-0.4593` | n/a (transformers) | BSD-3-Clause. **Not on the pod by decision** (Mike, 10-28: no new models). SFX/music QC runs basic checks and reports "unverified"; the code picks AST up if it is ever placed in `models/audio_classifiers/` |

Not used: ComfyUI-Chatterbox (CPU-only, downloads from HF; not linked into the Soundstage ComfyUI). Our
loader reads the same local weights directly on the GPU.

## QC

`SoundstageAudioQC` (and `soundstage.audio.qc.check`) runs the AudioSet AST classifier over 2 s windows
(max score per label) and Whisper for dialogue:
- fails on unwanted labels (SFX: Dog/Bark/Bow-wow/Growling/Cat/Speech ≥ 0.3-0.35, Music ≥ 0.45),
- fails when the prompt's sound words (footsteps, door, glass, engine…) map to AudioSet labels none of
  which is heard,
- dialogue: fails when Whisper's words differ from the line by WER > 0.35,
- always: silent or clipping clips.
Field notes baked in: Music 0.2-0.36 / Speech ~0.16 on an engine drone are false positives; Dog > 0.3 is
real. Waveforms and spectrograms are not a QC. Without a classifier the node says "unverified".

## Audio-driven LTX render

`SoundstageAudioDrivenShot` = Mike's OG-audio pattern, generalised:

```
audio / Cut mixdown WAV ─► Fit to shot (8k+1 frames @ fps) ─► VAEEncodeAudio (LTX audio VAE)
   ─► noise mask = audio_mask ─┐
stage clay ─► L2R IC guide ─────┼─► LTXVConcatAVLatent ─► sample (8 distilled steps, 960×544)
look still ─► guide @ -1 ───────┘      └─► crop guides ─► x2 upsample ─► re-guide ─► concat same audio ─► 3 steps
                                                                         └─► decode ─► CreateVideo(+ supplied audio)
```

Settings:
- **audio_mask**: noise mask on the audio latent. `0.0` = frozen (Mike's graph), best for effects/music:
  the picture follows the sound. `0.2-0.5` for dialogue: a fully frozen audio latent closes LTX's audio
  pathway and mouths stay shut (the documented "frozen mouth"); 0.3 is the default. This is the fix, not
  adding room tone to the WAV. Prep dialogue clean: trimmed, mono-compatible, ~-3 to -6 dBFS peak.
- **quality**: `final` = two-stage (960×544 → 1920×1088); `draft` = stage 1 only.
- **soundtrack**: `supplied` (default) puts your audio on the video, sample-exact to frame 0; `ltx` uses
  the model's re-decoded audio.
- **ref_tokens**: also attach the audio as reference tokens (`LTXVSetAudioRefTokens`), as in Mike's graph.
- Without `control_video` it is LTX image/text-to-video with the same audio conditioning (DualCFG 1/1).
- Prompt: describe the action that makes the sound ("their footsteps", "she says…"), not "clay/3D".
- Frames snap down to 8k+1; size to multiples of 64.

Feeding it from the Cut: `SoundstageCutExport` writes `…/audio/<shot_id>_mix.wav` + `audio/index.json`.
Set `mix_path` to that index.json (or the WAV) and `shot_id`; or wire `SoundstageAudioFit` → `audio`.

## In the Soundstage App (tools/app_build/audio.py)

`python tools/app_build/build.py` adds the audio part to `example_workflows/Soundstage_App_Full.json`:
- **Sound · line, SFX, music** (`SoundstageShotSound`): App panel fields line, character, voice (saved
  Character Voice name, blank = built-in), dialogue engine (Chatterbox default / ElevenLabs), SFX prompt,
  music mood. Fed the stage's frames (9045:5) and fps (9045:4). At run time it builds only the non-blank
  parts (DX1 0 dB from frame 6, FX1 −6 dB, MX1 −14 dB) and mixes them with `SoundstageMixClips` to the
  shot length; all blank → it blocks, nothing is generated (0.08 s) and the sound outputs are skipped.
- **Rung 4 · Final + sound**: CreateVideo(final frames 9066 + fps + mix) → Gate rung 4 → SaveVideo. The
  silent "Rung 4 · Final" is untouched; rungs 1-3 never run any of this (the gates are lazy).
- **Audio drives the video** (`SoundstageWhen`, default off; off = never runs) → `SoundstageAudioDrivenShot`
  (stage clay, look still, motion prompt, the mix, audio_mask 0.3) → Gate rung 4 → "Rung 4 · Final · audio-driven".
- Seeds are fixed so the ladder's cache reuses the sound between Runs.
- Blank fields: every pre-existing node keeps its id, widgets and inputs (A/B against a build without
  this part); the only id that moves is the Layer Pack folder preview added later by outputs.py. The
  added nodes are in the API prompt but inert when blank.
- Tested at rung 4 on :8189 (Chatterbox line + LTX footsteps): whole App run 493 s; Final + sound is
  frame-identical to the silent final, 4.041 s 48 kHz stereo track, Whisper hears the line. (That render
  predates the stage.mjs App-mode capture fix, so its clay/depth conditioning was undersized from frame ~4;
  the audio results are unaffected.)

## Integrator: wiring and Cut-tab buttons

1. `nodes_stage.py` → `get_node_list` module tuple: add `"nodes_audio"`. Restart :8189.
2. Cut tab buttons **Generate line / SFX / cue**: queue a one-node API prompt and append the returned
   clip to `project.audio`:
   ```js
   // kind: "SoundstageDialogue" | "SoundstageSFX" | "SoundstageMusic"
   const prompt = { "1": { class_type: "SoundstageSFX", inputs: {
       prompt: text, engine: "LTX-2.5 audio · local [open · <$10M]", duration_s: 2.0,
       shot_id: shot.id, track: "FX1", start_frame: playheadShotFrame, fps: project.fps, seed: Date.now() % 1e9 } } };
   const { prompt_id } = await (await api.fetchApi("/prompt", { method: "POST", body: JSON.stringify({ prompt }) })).json();
   // on the "executed" websocket event for node "1" (or the expanded SoundstageAudioClip inside it):
   //   msg.output.text[0] is the clip JSON → project.audio.push(JSON.parse(text)); timeline.onChange()
   ```
   Dialogue inputs: `line, character, engine: "Chatterbox · local [open · MIT]", shot_id, track: "DX1",
   start_frame, fps, seed`. Music: `genre, mood, tempo_bpm, length_s, instruments, engine, shot_id, track:
   "MX1", start_frame, fps, seed`. The clip node's UI also returns an `audio` preview entry (temp flac)
   for the panel's play button. Optionally chain `SoundstageAudioQC` (clip_json in, clip_json with
   `meta.qc` out) and show a red badge when `meta.qc.pass` is false.
3. "Render with this sound": after `SoundstageCutExport`, run `SoundstageAudioDrivenShot` with
   `mix_path = <folder>/audio/index.json`, `shot_id`, the stage clay as `control_video`, the look still as
   `first_frame`; `audio_mask` 0.3 when the shot has dialogue, else 0.0.

Example workflows: `example_workflows/Soundstage_AudioDriven_Walkin.json` (SFX ×2 + QC → mix → L2R shot)
and `Soundstage_AudioDriven_Dialogue.json` (line → QC → i2v shot), also in the pod's user workflows.

## Test results (pod RTX 6000 Ada 48 GB, ComfyUI 0.43, :8189, 2026-10-28)

Offline: `cd tests && python -m pytest test_audio_clip.py test_audio_graphs.py` → 42 passed (DSP, Cut
contract incl. a round-trip through `cut.mix.write_mixdown`, prompt hygiene, engine filtering, QC verdicts,
and every subgraph against the pod's /object_info). On :8189 all 8 nodes load; engine dropdowns show
Chatterbox / LTX-2.5 audio first, partner engines after.

Generation (GPU shared with other sessions; LTX weights already resident unless noted):

| Clip | Engine | Time | Result |
|---|---|---|---|
| footsteps, 4.2 s (texture prompt) | LTX-2.5 t2a | 13 s | **rejected**: a flat noise bed, 1 onset, no gaps between steps |
| footsteps, 4.2 s ("one distinct step every half second, near silence between") ×3 seeds | LTX-2.5 t2a | 48–152 s | 8–9 clean steps each, 0.50-0.52 s apart; seed 21 used |
| glass door opens, 2 s | LTX-2.5 t2a | 7.5 s | one clean transient + decay |
| "Somebody left the door open again. Was it you?" (PIP, built-in voice) | Chatterbox in node, GPU | 48 s (CPU: 319 s) | 2.3 s; Whisper QC PASS, WER 0.0 |
| neo-noir cue, 8 s, 90 BPM | LTX-2.5 t2a | (in a 208 s job with the two above + model load) | 8.0 s cue, -15 dBFS RMS |
| "...the latch barks" | SFX guard | n/a | rewritten to "snaps", warning shown on the node |

Audio-driven renders (97 frames @ 24 fps, two-stage distilled):

| Shot | Settings | Time |
|---|---|---|
| walk-in, Layout-To-Render, 1920×1024, footsteps FX1 + door FX2 @ frame 66 via the Cut mixdown | audio_mask 0 | 172-179 s |
| same, silent soundtrack (A/B control) | audio_mask 0 | 140 s |
| whole example workflow `Soundstage_AudioDriven_Walkin` (2 SFX + QC + fit + merge + render) | | 225 s |
| PIP puppet dialogue, i2v (no stage), 1280×704 | audio_mask 0 / 0.3 | 78 s / 45 s |
| whole example workflow `Soundstage_AudioDriven_Dialogue` (Chatterbox + QC + render) | audio_mask 0.3 | 83 s |

Is sync visible?
- **Door: yes.** With the mix, the right glass door swings open around frames 60-68, on the door SFX at frame 66.
  The silent control (same prompt "the door swings open", seed, clay) keeps the door shut. The sound is
  what triggers the event. The whole render diverges from the silent one over time (mean |Δ| 1 → 18/255),
  so the audio steers the shot, not just one event.
- **Footsteps: not shown.** In Layout-To-Render the stage clay drives the legs. The stage gait is
  procedural (stride 0.78 × height over the path: ~6-7 leg swings/s on this 18.5 m / 4 s path), and LTX
  turns it into a normal walk. I could not measure heel strikes against the 2 steps/s audio from the
  frames. To lock steps exactly: time the SFX to the stage's foot contacts, or generate the steps from
  the render with SoundstageSFX video-to-audio (LTX V2A).
- **Dialogue: yes with audio_mask 0.3, no when frozen.** Mouth opening (dark+red pixels in the face box) vs
  speech level per frame: mask 0.0 r = −0.05 (the mouth flaps through the silent tail too); mask 0.3 r =
  0.48 at lag 0; example workflow (real nodes) r = 0.37 at lag 0, 0.51 with the mouth 3 frames
  (125 ms) ahead of the audio. With 0.3 the mouth shuts when the line ends. This confirms the
  frozen-mouth fix: the audio-latent noise mask, not room tone. The character is a clay puppet, so no
  AI human face, and the voice is Chatterbox's built-in one, not a real person.

DX additions (character voice, TTS picker, voice change), live on :8189 and offline on the pod:

| Test | Result |
|---|---|
| Save voice without consent / without owner / < 3 s | refused with the consent text (tests) |
| `SoundstageVoice` load "PIP" → `SoundstageDialogue` (Chatterbox, PIP voice) → QC | PASS, Whisper WER 0.0; job (with VC below) 54 s |
| `SoundstageVoiceChange` (Chatterbox VC) timing | output length = input (2.56 s); syllable onsets 0.82/1.24/1.42/1.91 s → 0.82/1.22/1.40/1.92 s |
| Chatterbox VC identity | speaker similarity to the PIP voice: performer 0.57 → converted 0.81 (Chatterbox voice encoder) |
| Chatterbox VC words | clean source: "Somebody **lushed** the door open again. Was it you?" (1 word off); a −5-semitone pitch-shifted synthetic source came out garbled and **Audio QC failed it (WER 0.78)**, which is the intended catch. Use a natural human read (your own voice) as the performance |
| ElevenLabs TTS / Instant Voice Clone / Speech-to-Speech / SFX | graphs validated against the live schemas (all 4 TTS models, with and without clone); not run (no credits spent) |

The test voice "PIP" is the synthetic Chatterbox built-in voice (owner recorded as such), saved in the
pod's `user/soundstage/voices/`; no real person's voice was cloned.

Outputs on the pod: `output/soundstage_audio/` (clips per shot, `e2e/` test takes, the two example
workflow renders), `output/soundstage_cuts/walkin_audio/audio/` (Cut-format mixdown + index.json).

Known gaps: SFX/music QC is "unverified" (no AST on the pod, by decision); LTX video-to-audio and the
ElevenLabs engines are graph-validated against the live node schemas but not run (no credits spent).
