"""AAF for Avid Media Composer, written with pyaaf2 (pure Python: `pip install pyaaf2`).

Linked, not embedded: every clip is a MasterMob -> file SourceMob -> tape SourceMob chain whose
NetworkLocator points at the render (or, for clay-only shots, the expected <shot>.mov), so Avid opens
the sequence with media offline and relinks by name. One composition: TC (01:00:00:00), V1, one audio
track per lane (A1, A2...), and an Avid locator track holding the notes (and a RELINK locator on each
stand-in clip). Clip gain and fades stay in the EDL comments / XMLs, not here.
"""
from .export import (audible, audio_lanes, audio_len, audio_media, fps_info, layout, locator_entries, media_for,
                     normalize_project, record_start, relink_note, sequence_frames)

# Avid's locator colours as 16-bit RGB.
_RGB = {"Red": (65535, 0, 0), "Green": (0, 65535, 0), "Blue": (0, 0, 65535), "Cyan": (0, 65535, 65535),
        "Magenta": (65535, 0, 65535), "Yellow": (65535, 65535, 0), "Black": (0, 0, 0), "White": (65535, 65535, 65535)}


def available() -> bool:
    try:
        import aaf2  # noqa: F401
    except ImportError:
        return False
    return True


def write_aaf(path, project, media_root="") -> str:
    import aaf2

    p = normalize_project(project)
    fi = fps_info(p["fps"])
    edit_rate = f"{fi['num']}/{fi['den']}"
    base = fi["base"]
    rate = fi["num"] / fi["den"]

    with aaf2.open(path, "w") as f:
        comp = f.create.CompositionMob()
        comp.name = p["name"]
        comp.usage = "Usage_TopLevel"
        f.content.mobs.append(comp)

        tc_slot = comp.create_timeline_slot(edit_rate)
        tc_slot.name = "TC"
        tc_slot["PhysicalTrackNumber"].value = 1
        tc = f.create.Timecode()
        tc.fps = base
        tc.drop = False
        tc.start = record_start(base)
        tc.length = sequence_frames(p)
        tc_slot.segment = tc

        masters = {}

        def master_for(key, name, url, frames, kind, comment=""):
            """MasterMob (+ file and tape SourceMobs) for one piece of media, made once."""
            if key in masters:
                return masters[key]
            media_kind = "picture" if kind == "video" else "sound"

            tape = f.create.SourceMob()
            tape.name = name
            tape.descriptor = f.create.ImportDescriptor()
            loc = f.create.NetworkLocator()
            loc["URLString"].value = url
            tape.descriptor["Locator"].append(loc)
            f.content.mobs.append(tape)
            tape_slot = tape.create_empty_slot(edit_rate, media_kind)
            tape_slot.segment.length = frames

            filemob = f.create.SourceMob()
            filemob.name = name
            f.content.mobs.append(filemob)
            if kind == "video":
                desc = f.create.CDCIDescriptor()
                desc["ComponentWidth"].value = 8
                desc["HorizontalSubsampling"].value = 2
                desc["ImageAspectRatio"].value = f"{p['width']}/{p['height']}"
                desc["StoredWidth"].value = p["width"]
                desc["StoredHeight"].value = p["height"]
                desc["FrameLayout"].value = "FullFrame"
                desc["VideoLineMap"].value = [42, 0]
                desc["SampleRate"].value = edit_rate
                desc["Length"].value = frames
            else:
                desc = f.create.PCMDescriptor()
                desc["AverageBPS"].value = 48000 * 3 * 2
                desc["BlockAlign"].value = 6
                desc["QuantizationBits"].value = 24
                desc["AudioSamplingRate"].value = 48000
                desc["Channels"].value = 2
                desc["SampleRate"].value = 48000
                desc["Length"].value = int(round(frames / rate * 48000))
            loc2 = f.create.NetworkLocator()
            loc2["URLString"].value = url
            desc["Locator"].append(loc2)
            filemob.descriptor = desc
            file_slot = filemob.create_timeline_slot(edit_rate)
            fclip = filemob.create_source_clip(slot_id=file_slot.slot_id, length=frames, media_kind=media_kind)
            fclip.mob, fclip.slot, fclip.slot_id = tape, tape_slot, tape_slot.slot_id
            file_slot.segment = fclip

            master = f.create.MasterMob()
            master.name = name
            f.content.mobs.append(master)
            mslot = master.create_timeline_slot(edit_rate, slot_id=1 if kind == "video" else 2)
            mclip = master.create_source_clip(slot_id=mslot.slot_id, length=frames, media_kind=media_kind)
            mclip.mob, mclip.slot, mclip.slot_id = filemob, file_slot, file_slot.slot_id
            mslot.segment = mclip
            if comment:
                master.comments["Soundstage"] = comment
            masters[key] = (master, mslot)
            return masters[key]

        def place(seq_slot, master, mslot, start, length, kind):
            clip = comp.create_source_clip(slot_id=seq_slot.slot_id, start=int(start), length=int(length),
                                           media_kind="picture" if kind == "video" else "sound")
            clip.mob, clip.slot, clip.slot_id = master, mslot, mslot.slot_id
            return clip

        # V1
        vslot = comp.create_timeline_slot(edit_rate)
        vslot.name = "V1"
        vslot["PhysicalTrackNumber"].value = 1
        vseq = f.create.Sequence(media_kind="picture")
        vseq.components.value = []
        vslot.segment = vseq
        for row in layout(p):
            m = media_for(row["shot"], media_root)
            master, mslot = master_for("shot:" + row["shot"]["id"], row["shot"]["name"], m["url"], row["shot"]["frames"],
                                       "video", relink_note(m))
            vseq.components.append(place(vslot, master, mslot, row["in"], row["len"], "video"))

        # A1, A2... (one per lane, so no track has overlapping clips)
        for k, lane in enumerate(audio_lanes(p)):
            aslot = comp.create_timeline_slot(edit_rate)
            aslot.name = lane["name"] + ("" if audible(p, lane["track"]) else " (muted)")
            aslot["PhysicalTrackNumber"].value = k + 1
            aseq = f.create.Sequence(media_kind="sound")
            aseq.components.value = []
            aslot.segment = aseq
            pos = 0
            for a in lane["clips"]:
                if a["start_frame"] > pos:
                    aseq.components.append(f.create.Filler("sound", a["start_frame"] - pos))
                url = audio_media(a, media_root)["url"]
                master, mslot = master_for("audio:" + url, a["label"], url, max(a["frames"] or 0, a["out"]), "audio")
                aseq.components.append(place(aslot, master, mslot, a["in"], audio_len(a), "audio"))
                pos = a["start_frame"] + audio_len(a)

        # Avid locators (one per frame, the same list as the locator .txt)
        markers = [(e["frame"], e["length"], e["text"], e["user"], e["color"]) for e in locator_entries(p)]
        if markers:
            ev = f.create.EventMobSlot()
            ev["EditRate"].value = edit_rate
            ev["SlotID"].value = 1000
            ev["PhysicalTrackNumber"].value = 1
            mseq = f.create.Sequence(media_kind="DescriptiveMetadata")
            mseq.components.value = []
            for pos, length, text, user, color in markers:
                mk = f.create.DescriptiveMarker()
                mk["Position"].value = int(pos)
                mk["Length"].value = int(length)
                mk["Comment"].value = text
                mk["CommentMarkerUser"].value = user
                r, g, b = _RGB[color]
                mk["CommentMarkerColor"].value = {"red": r, "green": g, "blue": b}
                mk["DescribedSlots"].value = {vslot.slot_id}
                mseq.components.append(mk)
            ev.segment = mseq
            comp.slots.append(ev)
    return path
