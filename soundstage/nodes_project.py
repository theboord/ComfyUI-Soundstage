"""Soundstage · Shot Project nodes: publish a take as the next version of a shot, and load a shot's latest or
approved version into any workflow. The folder layout and the rules live in soundstage/shotproject (pure, tested)."""
from __future__ import annotations

import json
import os

from comfy_api.latest import IO, InputImpl

from . import shotproject as SP


def project_root(project: str) -> str:
    import folder_paths
    return os.path.join(folder_paths.get_output_directory(), "soundstage_projects", SP.slug(project, "my-film"))


def _path(ref: str) -> str:
    import folder_paths
    path = folder_paths.get_annotated_filepath(ref.strip()) if ref and ref.strip() else ""
    if not path or not os.path.exists(path):
        raise ValueError(f"No such file: {ref}")
    return path


def publish_take(project, sequence, shot, task, video, note="", author="", approve=False, extra="") -> dict:
    """Shared by the node and the HTTP route. `video` is a take ('soundstage/final_00001_.mp4 [output]');
    `extra` is an optional second path (a Layer Pack folder, a frame)."""
    vpath = _path(video)
    files = [(vpath, "video")]
    if extra and extra.strip():
        files.append((_path(extra), "layerpack" if os.path.isdir(_path(extra)) else "extra"))
    return SP.publish(project_root(project), sequence, shot, task, files, SP.collect_take_extras(vpath),
                      note=note, author=author, approve_it=bool(approve))


class SoundstagePublishVersion(IO.ComfyNode):
    @classmethod
    def define_schema(cls) -> IO.Schema:
        return IO.Schema(
            node_id="SoundstagePublishVersion",
            display_name="Soundstage · Publish Version",
            category="Soundstage/Project",
            description="Publish a take as the next version of a shot: output/soundstage_projects/<project>/<seq>/<shot>/"
                        "<task>/v001/. The version keeps the video, the stage + shot recipe, the exact ComfyUI graph, "
                        "the take-check scores, your note and a checksum of every file. Mark one version Approved.",
            inputs=[
                IO.String.Input("video", default="", tooltip="A take in the output folder: 'soundstage/final_00001_.mp4 [output]'."),
                IO.String.Input("project", default="my-film"),
                IO.String.Input("sequence", default="SEQ010"),
                IO.String.Input("shot", default="SH010"),
                IO.Combo.Input("task", options=list(SP.TASKS), default="final"),
                IO.String.Input("note", default="", multiline=True),
                IO.Boolean.Input("approve", default=False, tooltip="Make this the approved version of the shot."),
                IO.String.Input("extra", default="", advanced=True,
                                tooltip="Optional: a Layer Pack folder or a second file to keep with the version."),
                IO.String.Input("author", default="", advanced=True),
            ],
            outputs=[IO.String.Output(display_name="version_json")],
            is_output_node=True,
        )

    @classmethod
    def execute(cls, video="", project="my-film", sequence="SEQ010", shot="SH010", task="final", note="",
                approve=False, extra="", author="") -> IO.NodeOutput:
        rec = publish_take(project, sequence, shot, task, video, note, author, approve, extra)
        text = json.dumps({k: rec[k] for k in ("name", "sequence", "shot", "task", "created", "primary", "dir")})
        return IO.NodeOutput(text, ui={"text": [text]})


class SoundstageLoadVersion(IO.ComfyNode):
    @classmethod
    def define_schema(cls) -> IO.Schema:
        return IO.Schema(
            node_id="SoundstageLoadVersion",
            display_name="Soundstage · Load Version",
            category="Soundstage/Project",
            description="Load a shot's latest, approved or numbered (v003) version from a Soundstage project, so another "
                        "workflow can pick the shot up without anyone passing files around.",
            inputs=[
                IO.String.Input("project", default="my-film"),
                IO.String.Input("sequence", default="SEQ010"),
                IO.String.Input("shot", default="SH010"),
                IO.Combo.Input("task", options=list(SP.TASKS), default="final"),
                IO.String.Input("version", default="latest", tooltip="latest, approved, or a number like v003."),
            ],
            outputs=[IO.Video.Output(display_name="video"), IO.String.Output(display_name="path"),
                     IO.String.Output(display_name="version_json")],
        )

    @classmethod
    def execute(cls, project="my-film", sequence="SEQ010", shot="SH010", task="final", version="latest") -> IO.NodeOutput:
        try:
            v = SP.resolve(project_root(project), sequence, shot, task, version)
        except LookupError as e:
            raise ValueError(str(e)) from e
        path = v["primary_path"]
        if not os.path.isfile(path):
            raise ValueError(f"{v['name']} is published but its file is missing: {path}")
        text = json.dumps({k: v[k] for k in ("name", "sequence", "shot", "task", "created", "note", "primary")})
        return IO.NodeOutput(InputImpl.VideoFromFile(path), path, text)


NODES = [SoundstagePublishVersion, SoundstageLoadVersion]
