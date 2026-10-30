"""Audio department in the App: sound on the final shot, set from the App panel.

Adds (all behind the rung-4 gate, so rungs 1-3 never touch them):
  SoundstageShotSound  line / character / voice / dialogue engine / SFX prompt / music mood, mixed to the
                       stage's frames (9045:5) and fps (9045:4). Builds only the non-blank parts at run time;
                       all blank = it blocks, nothing is generated and the sound outputs are skipped.
  CreateVideo(9066 final images + fps, mix) -> Gate rung 4 -> SaveVideo "Rung 4 · Final + sound"
  "Audio drives the video" (SoundstageWhen, default off) -> SoundstageAudioDrivenShot (stage clay + look still +
                       motion prompt + the mix) -> Gate rung 4 -> SaveVideo "Rung 4 · Final · audio-driven"
The silent "Rung 4 · Final" is untouched.
"""
STAGE, LOOK, STEP, LOOK_STILL, FINAL_FRAMES, FINAL_SAVE = 9045, 9079, 9059, 9057, 9066, 4852
CHATTERBOX = "Chatterbox · local [open · MIT]"


def _w(name, typ):
    return (name, typ, name)


def _gate(g, src, slot, typ, pos):
    gid = g.add_node("SoundstageGate", pos, inputs=[("step", "INT"), ("value", typ), _w("rung", "INT")],
                     outputs=[("value", typ)], widgets=[4], title="Gate · rung 4", size=(220, 80))
    g.link(STEP, 0, gid, "step", "INT")
    g.link(src, slot, gid, "value", typ)
    return gid


def _save(g, src, pos, title, prefix):
    sid = g.add_node("SaveVideo", pos, inputs=[("video", "VIDEO"), _w("filename_prefix", "STRING"),
                                               _w("format.codec", "COMBO"), _w("format", "COMBO"), _w("codec", "COMBO")],
                     widgets=[prefix, "auto", "auto", "auto"], title=title, size=(420, 420))
    g.link(src, 0, sid, "video", "VIDEO")
    return sid


def apply(g):
    if any(n["type"] == "SoundstageShotSound" for n in g.nodes.values()):
        return
    x, y = g.nodes[FINAL_SAVE]["pos"]
    x, y = x + 520, y

    # 1) the shot's sound
    snd = g.add_node("SoundstageShotSound", (x, y - 760),
                     inputs=[("frames", "INT"), ("fps", "FLOAT"), _w("line", "STRING"), _w("character", "STRING"),
                             _w("voice", "STRING"), _w("dialogue_engine", "COMBO"), _w("sfx_prompt", "STRING"),
                             _w("music_mood", "STRING"), _w("seed", "INT"), _w("dialogue_start_frame", "INT")],
                     outputs=[("mix", "AUDIO"), ("mix_json", "STRING")],
                     # frontend widget order: required widgets, seed + its control, then optional/advanced
                     widgets=["", "", "", CHATTERBOX, "", "", 0, "fixed", 6], title="Sound · line, SFX, music",
                     size=(420, 520))
    g.link(STAGE, 5, snd, "frames", "INT")
    g.link(STAGE, 4, snd, "fps", "FLOAT")

    # 2) final + sound: the rung-4 final's frames with the mix muxed on
    mux = g.add_node("CreateVideo", (x, y - 200),
                     inputs=[("images", "IMAGE"), ("audio", "AUDIO"), _w("fps", "FLOAT"), _w("bit_depth", "COMBO"),
                             _w("color_space", "COMBO"), _w("codec", "COMBO")],
                     outputs=[("VIDEO", "VIDEO")], widgets=[24, "auto", "sRGB", "none"], title="Final + sound (mux)",
                     size=(320, 160))
    g.link(FINAL_FRAMES, 0, mux, "images", "IMAGE")
    g.link(FINAL_FRAMES, 2, mux, "fps", "FLOAT")
    g.link(snd, 0, mux, "audio", "AUDIO")
    gate = _gate(g, mux, 0, "VIDEO", (x, y))
    save = _save(g, gate, (x, y + 120), "Rung 4 · Final + sound", "soundstage/final_sound")

    # 3) optional: audio drives the video (default off; off = never runs)
    ax = x + 480
    drv = g.add_node("SoundstageAudioDrivenShot", (ax, y - 760),
                     inputs=[("audio", "AUDIO"), ("control_video", "IMAGE"), ("first_frame", "IMAGE"),
                             _w("prompt", "STRING"), _w("width", "INT"), _w("height", "INT"), _w("frames", "INT"),
                             _w("fps", "FLOAT"), _w("audio_mask", "FLOAT"), _w("quality", "COMBO"), _w("seed", "INT"),
                             _w("mix_path", "STRING"), _w("shot_id", "STRING"), _w("negative", "STRING"),
                             _w("offset_s", "FLOAT"), _w("soundtrack", "COMBO"), _w("ref_tokens", "BOOLEAN")],
                     outputs=[("video", "VIDEO"), ("frames", "IMAGE"), ("audio", "AUDIO")],
                     widgets=["", 1920, 1088, 97, 24.0, 0.3, "final", 42, "fixed", "", "app_shot", "", 0.0, "supplied",
                              False],
                     title="Audio-driven final (LTX-2.5 + sound)", size=(420, 600))
    g.link(snd, 0, drv, "audio", "AUDIO")
    g.link(LOOK, 2, drv, "prompt", "STRING")
    g.link(STAGE, 0, drv, "control_video", "IMAGE")
    g.link(LOOK_STILL, 0, drv, "first_frame", "IMAGE")
    g.link(STAGE, 5, drv, "frames", "INT")
    g.link(STAGE, 4, drv, "fps", "FLOAT")
    when = g.add_node("SoundstageWhen", (ax, y - 120), inputs=[("value", "VIDEO"), _w("enabled", "BOOLEAN")],
                      outputs=[("value", "VIDEO")], widgets=[False], title="Audio drives the video", size=(260, 80))
    g.link(drv, 0, when, "value", "VIDEO")
    dgate = _gate(g, when, 0, "VIDEO", (ax, y))
    dsave = _save(g, dgate, (ax, y + 120), "Rung 4 · Final · audio-driven", "soundstage/final_audiodriven")

    # 4) App panel
    for w in ("line", "character", "voice", "dialogue_engine", "sfx_prompt", "music_mood"):
        g.expose(snd, w)
    g.expose(when, "enabled")
    g.show_output(save)
    g.show_output(dsave)
