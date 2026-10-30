"""Soundstage Cut nodes: hand the Cut tab's edit to every NLE, and its temp sound back to LTX.

SoundstageCutExport writes output/soundstage_cuts/<name>/ (same folder every export):
  <name>.aaf (Avid; needs pyaaf2), <name>.edl (Avid / Premiere / Resolve), <name>_avid_locators.txt (Avid
  markers), <name>_premiere.xml (Premiere, FCP7 XML), <name>.fcpxml (Resolve, Final Cut), <name>.otio
  (Resolve, OTIO tools), RELINK.txt, project.json, and audio/: <name>_mix.wav, <shot_id>_mix.wav per
  shot (48 kHz / 24-bit, sample 0 = shot frame 0) and index.json.
SoundstageCutShotAudio loads one shot's mix as AUDIO for LTX audio conditioning.
The writers live in soundstage/cut and have no ComfyUI imports.
"""
import json
import os

import torch

import folder_paths
from comfy_api.latest import IO

from .cut import write_cut
from .cut.export import safe_name

OUTPUT_SUBDIR = "soundstage_cuts"


def _cut_folder(folder_or_name: str) -> str:
    """A folder path, or a cut name under output/soundstage_cuts/."""
    if folder_or_name and os.path.isdir(folder_or_name):
        return folder_or_name
    return os.path.join(folder_paths.get_output_directory(), OUTPUT_SUBDIR, safe_name(folder_or_name))


class CutExport(IO.ComfyNode):
    @classmethod
    def define_schema(cls) -> IO.Schema:
        return IO.Schema(
            node_id="SoundstageCutExport",
            display_name="Soundstage · Cut: Export to Avid / Premiere / Resolve / FCP",
            category="Soundstage",
            search_aliases=["edl", "cmx3600", "aaf", "avid", "otio", "fcpxml", "xml", "resolve", "premiere",
                            "final cut", "conform", "cut", "mixdown"],
            description="Write the Cut tab's edit to output/soundstage_cuts/<name>/ in each NLE's best format: AAF + "
                        "EDL + locators for Avid, FCP7 XML for Premiere, FCPXML + OTIO for Resolve, FCPXML for Final "
                        "Cut. Audio tracks go along as stems, and audio/<shot_id>_mix.wav is each shot's temp mix for "
                        "LTX audio conditioning. Media = Final where rendered, else the Draft / Look / clay stand-in "
                        "with a relink note.",
            is_output_node=True,
            inputs=[
                IO.String.Input("project_json", multiline=True, default="",
                                tooltip="Cut project: {fps, shots, cut, audio} (docs/cut.md)."),
                IO.String.Input("name", default="", optional=True,
                                tooltip="Sequence / folder name. Empty = the project's name."),
                IO.Combo.Input("edl_reels", options=["8 (CMX3600)", "32 (Avid File_32)"], default="8 (CMX3600)",
                               optional=True, tooltip="Reel name width in the EDL. Full names are always in "
                                                      "FROM CLIP NAME."),
                IO.Boolean.Input("audio_mixdown", default=True, optional=True,
                                 tooltip="Write the cut mix and one mix WAV per shot (48 kHz / 24-bit) + index.json."),
            ],
            outputs=[IO.String.Output(display_name="folder"), IO.String.Output(display_name="mix_index")],
        )

    @classmethod
    def execute(cls, project_json, name="", edl_reels="8 (CMX3600)", audio_mixdown=True) -> IO.NodeOutput:
        try:
            project = json.loads(project_json) if isinstance(project_json, str) else dict(project_json)
        except json.JSONDecodeError as e:
            raise ValueError(f"Soundstage Cut: project_json is not valid JSON ({e}).") from e
        if not project.get("cut") and not project.get("audio"):
            raise ValueError("Soundstage Cut: the project has no cut events; put shots on the Cut tab's track first.")
        out_root = folder_paths.get_output_directory()
        roots = {"output": out_root, "input": folder_paths.get_input_directory(), "temp": folder_paths.get_temp_directory()}
        res = write_cut(project, os.path.join(out_root, OUTPUT_SUBDIR), name=name or "", media_root=out_root, roots=roots,
                        reel_width=32 if str(edl_reels).startswith("32") else 8, mixdown=bool(audio_mixdown))
        lines = [f"Cut written: {res['folder']}", *res["files"]]
        if res.get("aaf_error"):
            lines.append(f"(no AAF: {res['aaf_error']})")
        mix = res.get("mix")
        if mix and mix.get("has_audio"):
            lines.append(f"audio/: cut mix + {len(mix['shots'])} shot mixes")
            lines += [f"  audio problem: {p['label']}: {p['error']}" for p in mix.get("problems", [])]
        return IO.NodeOutput(res["folder"], res.get("mix_index") or "", ui={"text": ["\n".join(lines)]})


class CutShotAudio(IO.ComfyNode):
    @classmethod
    def define_schema(cls) -> IO.Schema:
        return IO.Schema(
            node_id="SoundstageCutShotAudio",
            display_name="Soundstage · Cut: Shot Audio (temp mix)",
            category="Soundstage",
            search_aliases=["shot audio", "temp sfx", "mixdown", "audio conditioning", "ltx audio"],
            description="Load one shot's temp mix from a Cut export (audio/<shot_id>_mix.wav): exactly the shot's "
                        "length, sample 0 = shot frame 0. Feed it to LTX as audio conditioning for the final render.",
            inputs=[
                IO.String.Input("cut", default="", tooltip="The export folder (Cut Export's folder output) or the cut name."),
                IO.String.Input("shot_id", default="", tooltip="Shot id from the project (the file is <shot_id>_mix.wav)."),
            ],
            outputs=[IO.Audio.Output(display_name="audio"), IO.Int.Output(display_name="frames"),
                     IO.Float.Output(display_name="fps")],
        )

    @classmethod
    def execute(cls, cut, shot_id) -> IO.NodeOutput:
        from .cut.mix import decode
        folder = _cut_folder(cut)
        index_path = os.path.join(folder, "audio", "index.json")
        if not os.path.exists(index_path):
            raise ValueError(f"Soundstage Cut: no audio index at {index_path}. Run Cut Export with audio_mixdown on.")
        with open(index_path, encoding="utf-8") as f:
            index = json.load(f)
        shot = next((s for s in index["shots"] if s["shot_id"] == str(shot_id)), None)
        if not shot:
            have = ", ".join(s["shot_id"] for s in index["shots"]) or "none (the cut has no audio)"
            raise ValueError(f"Soundstage Cut: shot '{shot_id}' is not in {index_path}. Shots: {have}")
        data = decode(os.path.join(folder, shot["file"]))
        waveform = torch.from_numpy(data.T.copy()).unsqueeze(0)  # [1, channels, samples]
        return IO.NodeOutput({"waveform": waveform, "sample_rate": index["sample_rate"]}, int(shot["frames"]),
                             float(index["fps"]))


NODES = [CutExport, CutShotAudio]
