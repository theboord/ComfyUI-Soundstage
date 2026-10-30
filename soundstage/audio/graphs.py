"""Backend subgraphs for the audio nodes (GraphBuilder, expanded at run time). Pure Python.

g is a comfy_execution.graph_utils.GraphBuilder (or the test fake); links are [node_id, slot].
Every node and input used here is checked against a /object_info snapshot of the pod's ComfyUI
v0.43 in tests/test_audio_graphs.py.

Audio-driven LTX-2.5 (the pattern in Mike's OG-audio union-control graph):
    supplied AUDIO -> fit to the shot (frames / fps) -> VAEEncodeAudio (LTX audio VAE)
    -> noise mask m on the audio latent -> LTXVConcatAVLatent with the (IC-LoRA guided) video latent
    -> sample. m = 0 freezes the audio (picture follows it, but talking mouths can stay shut);
    m = 0.2-0.5 keeps the model's audio pathway open so lips move (the LTX "frozen mouth" fix).
    The supplied audio, not the re-decoded one, becomes the final soundtrack.
"""
import math

LTX_SIGMAS = "1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0"
LTX_S2_L2R = "0.909375, 0.725, 0.421875, 0.0"
LTX_S2_I2V = "0.85, 0.7250, 0.4219, 0.0"
LTX_NEGATIVE = "pc game, console game, video game, cartoon, childish, ugly"
SFX_NEGATIVE = "dog, animal, voice, speech, talking, music, singing"
AUDIO_FPS = 25  # LTX's native audio clock for text-to-audio (any fps works; this is the reference one)


def ltx_frames(n):
    """LTX wants 8k+1 frames."""
    n = max(9, int(n))
    return ((n - 1) // 8) * 8 + 1


def ltx_frames_cover(n):
    """Smallest 8k+1 >= n."""
    n = max(9, int(math.ceil(n)))
    return ((n - 1 + 7) // 8) * 8 + 1


def snap(v, m):
    return max(m, int(round(v / m)) * m)


def resize(g, link, w, h, crop="center", method="lanczos"):
    return g.node("ResizeImageMaskNode", input=link, scale_method=method,
                  **{"resize_type": "scale dimensions", "resize_type.width": int(w),
                     "resize_type.height": int(h), "resize_type.crop": crop}).out(0)


def _text(g, w, prompt, negative, fps):
    clip = g.node("CLIPLoader", clip_name=w["text_encoder"], type="ltxv", device="default").out(0)
    pos = g.node("CLIPTextEncode", text=prompt, clip=clip).out(0)
    neg = g.node("CLIPTextEncode", text=negative, clip=clip).out(0)
    cond = g.node("LTXVConditioning", positive=pos, negative=neg, frame_rate=float(fps))
    return cond.out(0), cond.out(1)


def _sample(g, model, pos, neg, latent, seed, sigmas, guider="cfg"):
    if guider == "cfg":
        gd = g.node("CFGGuider", model=model, positive=pos, negative=neg, cfg=1.0).out(0)
    else:
        gd = g.node("LTXVDualCFGGuider", model=model, positive=pos, negative=neg, video_cfg=1.0,
                    audio_cfg=1.0).out(0)
    return g.node("SamplerCustomAdvanced", noise=g.node("RandomNoise", noise_seed=int(seed) % (2 ** 63)).out(0),
                  guider=gd, sampler=g.node("KSamplerSelect", sampler_name="euler_ancestral").out(0),
                  sigmas=g.node("ManualSigmas", sigmas=sigmas).out(0), latent_image=latent).out(0)


def _unet(g, w):
    return g.node("UNETLoader", unet_name=w["unet"], weight_dtype="default").out(0)


def _audio_vae(g, w):
    return g.node("VAELoader", vae_name=w["audio_vae"]).out(0)


# ---------------------------------------------------------------- LTX-2.5 text -> audio (SFX, music)

def ltx_text_to_audio(g, w, prompt, seconds, seed, negative=SFX_NEGATIVE):
    """LTX-2.5 in audio-only mode (no video stream). Returns an AUDIO link a little longer than
    `seconds` (8k+1 frames at 25 fps); the clip node trims it."""
    model = g.node("LTXVAudioOnlyModel", model=_unet(g, w)).out(0)
    avae = _audio_vae(g, w)
    pos, neg = _text(g, w, prompt, negative, AUDIO_FPS)
    n = ltx_frames_cover(seconds * AUDIO_FPS + 1)
    alat = g.node("LTXVEmptyLatentAudio", frames_number=n, frame_rate=AUDIO_FPS, batch_size=1, audio_vae=avae).out(0)
    av = g.node("LTXVConcatAVLatent", video_latent=g.node("LTXVAudioOnlyEmptyVideoLatent").out(0),
                audio_latent=alat).out(0)
    s = g.node("LTXVSeparateAVLatent", av_latent=_sample(g, model, pos, neg, av, seed, LTX_SIGMAS))
    return g.node("LTXVAudioVAEDecode", samples=s.out(1), audio_vae=avae).out(0)


# ---------------------------------------------------------------- LTX-2.5 video -> audio (synced SFX)

def ltx_video_to_audio(g, w, frames_link, n_frames, fps, prompt, seed, src_w=960, src_h=544, negative=SFX_NEGATIVE):
    """Foley for a clip: the clip is encoded and frozen (noise mask 0), only the audio is generated, so
    the sound lands on the picture's events. Uses the first 8k+1 frames at ~544p."""
    n = ltx_frames(min(int(n_frames), 1000))
    W = snap(544 * src_w / max(src_h, 1), 32) if src_w >= src_h else 544
    H = 544 if src_w >= src_h else snap(544 * src_h / max(src_w, 1), 32)
    vae = g.node("VAELoader", vae_name=w["vae"]).out(0)
    avae = _audio_vae(g, w)
    clip = g.node("ImageFromBatch", image=frames_link, batch_index=0, length=n).out(0)
    vlat = g.node("VAEEncode", pixels=resize(g, clip, W, H), vae=vae).out(0)
    vlat = g.node("SoundstageLatentNoiseMask", latent=vlat, value=0.0).out(0)
    alat = g.node("LTXVEmptyLatentAudio", frames_number=n, frame_rate=float(fps), batch_size=1, audio_vae=avae).out(0)
    av = g.node("LTXVConcatAVLatent", video_latent=vlat, audio_latent=alat).out(0)
    pos, neg = _text(g, w, prompt, negative, fps)
    s = g.node("LTXVSeparateAVLatent", av_latent=_sample(g, _unet(g, w), pos, neg, av, seed, LTX_SIGMAS))
    return g.node("LTXVAudioVAEDecode", samples=s.out(1), audio_vae=avae).out(0)


# ---------------------------------------------------------------- audio-driven shot

def _ic_guide(g, pos, neg, vae, latent, image, idx, ldf, crop):
    return g.node("LTXAddVideoICLoRAGuide", positive=pos, negative=neg, vae=vae, latent=latent, image=image,
                  frame_idx=idx, strength=1.0, latent_downscale_factor=ldf, crop=crop, use_tiled_encode=False,
                  tile_size=256, tile_overlap=64)


def _audio_latent(g, audio_link, avae, mask):
    lat = g.node("VAEEncodeAudio", audio=audio_link, vae=avae).out(0)
    return lat, g.node("SoundstageLatentNoiseMask", latent=lat, value=float(mask)).out(0)


def _ref_tokens(g, pos, neg, audio_lat):
    r = g.node("LTXVSetAudioRefTokens", positive=pos, negative=neg, audio_latent=audio_lat)
    return r.out(0), r.out(1)


def audio_driven_shot(g, w, p):
    """p: prompt, negative, seed, width, height, frames, fps, control (link|None), first (link|None),
    audio (raw AUDIO link), offset_s, audio_mask, quality ('final'|'draft'), soundtrack ('supplied'|'ltx'),
    ref_tokens (bool). Returns {"video", "images", "audio"} links."""
    W, H = snap(p["width"], 64), snap(p["height"], 64)
    n = ltx_frames(p["frames"])
    fps = float(p["fps"])
    fitted = g.node("SoundstageAudioFit", audio=p["audio"], frames=n, fps=fps,
                    offset_s=float(p.get("offset_s") or 0.0)).out(0)
    vae = g.node("VAELoader", vae_name=w["vae"]).out(0)
    avae = _audio_vae(g, w)
    pos, neg = _text(g, w, p["prompt"], p.get("negative") or LTX_NEGATIVE, fps)
    base = _unet(g, w)
    a_raw, a_lat = _audio_latent(g, fitted, avae, p.get("audio_mask", 0.3))
    if p.get("control") is not None:
        out_lat, a_final = _l2r(g, w, p, base, vae, pos, neg, a_raw, a_lat, W, H, n)
        temporal = (128, 32)
    else:
        out_lat, a_final = _i2v(g, w, p, base, vae, pos, neg, a_raw, a_lat, W, H, n)
        temporal = (64, 16)
    images = g.node("VAEDecodeTiled", samples=out_lat, vae=vae, tile_size=512, overlap=64,
                    temporal_size=temporal[0], temporal_overlap=temporal[1]).out(0)
    if p.get("soundtrack", "supplied") == "ltx":
        audio = g.node("LTXVAudioVAEDecode", samples=a_final, audio_vae=avae).out(0)
    else:
        audio = fitted
    video = g.node("CreateVideo", images=images, fps=fps, audio=audio).out(0)
    return {"video": video, "images": images, "audio": audio}


def _l2r(g, w, p, base, vae, pos, neg, a_raw, a_lat, W, H, n):
    """LTX-2.5 Layout-To-Render two-stage distilled (Soundstage_Shot_v2_ladder) with the audio stream."""
    if not w.get("l2r_lora"):
        raise ValueError("Layout-to-Render needs ltx-2.5-22b-ic-lora-layout-to-render-1.0.safetensors in loras.")
    lora = g.node("LTXICLoRALoaderModelOnly", model=base, lora_name=w["l2r_lora"], strength_model=1.0)
    model, ldf = lora.out(0), lora.out(1)
    ctrl = resize(g, p["control"], W // 2, H // 2)
    lat = g.node("EmptyLTXVLatentVideo", width=W // 2, height=H // 2, length=n, batch_size=1).out(0)
    gd = _ic_guide(g, pos, neg, vae, lat, ctrl, 0, ldf, "disabled")
    if p.get("first") is not None:
        gd = _ic_guide(g, gd.out(0), gd.out(1), vae, gd.out(2), p["first"], -1, ldf, "center")
    gp, gn = gd.out(0), gd.out(1)
    if p.get("ref_tokens"):
        gp, gn = _ref_tokens(g, gp, gn, a_raw)
    av = g.node("LTXVConcatAVLatent", video_latent=gd.out(2), audio_latent=a_lat).out(0)
    s1 = g.node("LTXVSeparateAVLatent", av_latent=_sample(g, model, gp, gn, av, p["seed"], LTX_SIGMAS))
    c1 = g.node("LTXVCropGuides", positive=gd.out(0), negative=gd.out(1), latent=s1.out(0))
    if p.get("quality") == "draft":
        return c1.out(2), s1.out(1)
    up_model = g.node("LatentUpscaleModelLoader", model_name=w["upscaler"]).out(0)
    up = g.node("LTXVLatentUpsampler", samples=c1.out(2), upscale_model=up_model, vae=vae).out(0)
    hd = _ic_guide(g, pos, neg, vae, up, ctrl, 0, 1.0, "disabled")
    if p.get("first") is not None:
        hd = _ic_guide(g, hd.out(0), hd.out(1), vae, hd.out(2), p["first"], -1, 1.0, "center")
    hp, hn = hd.out(0), hd.out(1)
    if p.get("ref_tokens"):
        hp, hn = _ref_tokens(g, hp, hn, a_raw)
    av2 = g.node("LTXVConcatAVLatent", video_latent=hd.out(2), audio_latent=a_lat).out(0)
    s2 = g.node("LTXVSeparateAVLatent", av_latent=_sample(g, model, hp, hn, av2, p["seed"], LTX_S2_L2R))
    c2 = g.node("LTXVCropGuides", positive=hd.out(0), negative=hd.out(1), latent=s2.out(0))
    return c2.out(2), s2.out(1)


def _i2v(g, w, p, base, vae, pos, neg, a_raw, a_lat, W, H, n):
    """LTX-2.5 image/text-to-video two-stage distilled (template video_ltx2_5_i2v) with the audio stream."""
    pre = None
    if p.get("first") is not None:
        pre = g.node("LTXVPreprocess", image=resize(g, p["first"], W, H), img_compression=18).out(0)
    lat = g.node("EmptyLTXVLatentVideo", width=W // 2, height=H // 2, length=n, batch_size=1).out(0)
    if pre is not None:
        lat = g.node("LTXVImgToVideoInplace", vae=vae, image=pre, latent=lat, strength=0.7, bypass=False).out(0)
    cp, cn = pos, neg
    if p.get("ref_tokens"):
        cp, cn = _ref_tokens(g, pos, neg, a_raw)
    av = g.node("LTXVConcatAVLatent", video_latent=lat, audio_latent=a_lat).out(0)
    s1 = g.node("LTXVSeparateAVLatent", av_latent=_sample(g, base, cp, cn, av, p["seed"], LTX_SIGMAS, "dual"))
    if p.get("quality") == "draft":
        return s1.out(0), s1.out(1)
    up_model = g.node("LatentUpscaleModelLoader", model_name=w["upscaler"]).out(0)
    up = g.node("LTXVLatentUpsampler", samples=s1.out(0), upscale_model=up_model, vae=vae).out(0)
    if pre is not None:
        up = g.node("LTXVImgToVideoInplace", vae=vae, image=pre, latent=up, strength=1.0, bypass=False).out(0)
    av2 = g.node("LTXVConcatAVLatent", video_latent=up, audio_latent=a_lat).out(0)
    s2 = g.node("LTXVSeparateAVLatent", av_latent=_sample(g, base, cp, cn, av2, p["seed"], LTX_S2_I2V, "dual"))
    return s2.out(0), s2.out(1)


# ---------------------------------------------------------------- partner nodes (ElevenLabs via Comfy)

def _el_voice(g, params, clone_audio=None):
    """A saved Character Voice becomes an Instant Voice Clone; otherwise the chosen preset voice."""
    if clone_audio is not None:
        return g.node("ElevenLabsInstantVoiceClone", remove_background_noise=False, **{"files.audio0": clone_audio}).out(0)
    return g.node("ElevenLabsVoiceSelector", voice=params.get("preset_voice", "River (neutral, american)")).out(0)


def _el_tts_model(params):
    model = params.get("model", "eleven_v4")
    speed = round(min(1.2, max(0.7, float(params.get("speed", 1.0)))), 2)
    sim = float(params.get("similarity", 0.75))
    nested = {"model": model, "model.similarity_boost": sim}
    if model in ("eleven_v3", "eleven_multilingual_v2"):
        nested["model.speed"] = speed
    if model == "eleven_multilingual_v2":
        nested.update({"model.use_speaker_boost": False, "model.style": 0.0})
    return nested


def elevenlabs_tts(g, text, seed, params, clone_audio=None):
    voice = _el_voice(g, params, clone_audio)
    return g.node("ElevenLabsTextToSpeech", voice=voice, text=text, stability=float(params.get("stability", 0.5)),
                  apply_text_normalization="auto", language_code=str(params.get("language", "") or ""),
                  seed=int(seed) % 2147483647, output_format="opus_48000_192", **_el_tts_model(params)).out(0)


def elevenlabs_sts(g, audio_link, seed, params, clone_audio=None):
    """Speech-to-speech: keeps the performance's timing and delivery, swaps the voice."""
    voice = _el_voice(g, params, clone_audio)
    return g.node("ElevenLabsSpeechToSpeech", voice=voice, audio=audio_link,
                  stability=float(params.get("stability", 0.5)), output_format="opus_48000_192",
                  seed=int(seed) % 4294967295, remove_background_noise=bool(params.get("remove_noise", False)),
                  **{"model": params.get("model", "eleven_multilingual_sts_v2"), "model.speed": 1.0,
                     "model.similarity_boost": float(params.get("similarity", 0.75)),
                     "model.use_speaker_boost": False, "model.style": 0.0}).out(0)


def elevenlabs_sfx(g, prompt, seconds, params):
    return g.node("ElevenLabsTextToSoundEffects", text=prompt, output_format="opus_48000_192",
                  **{"model": "eleven_sfx_v2", "model.duration": round(min(30.0, max(0.5, seconds)), 1),
                     "model.loop": False, "model.prompt_influence": float(params.get("prompt_influence", 0.3))}).out(0)
