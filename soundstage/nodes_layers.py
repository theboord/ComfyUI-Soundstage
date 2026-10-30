"""Soundstage Layer Pack nodes: package a shot for post.

Start -> Add Layer (one per character / prop / plate) -> Add AOV (depth, normals) -> Export.
Add All Actors does the Add Layer step for a whole stage at once: background + one layer per actor.
Export writes ComfyUI/output/soundstage_layerpacks/<shot>_<timestamp>/ with per-layer PNG
sequences (straight alpha), mattes, ProRes 4444, a hero-frame PSD, depth EXR, the staged camera
(camera.json, Nuke .chan) and builders for After Effects, Blender, Nuke and Resolve (OTIO).
The writers live in soundstage/layerpack and have no ComfyUI imports.
"""
import json
import os

import torch

import folder_paths
from comfy_api.latest import IO, UI

from .layerpack import AOV, AOV_KINDS, BLEND_MODES, DEPTH_ENCODINGS, KINDS, Layer, LayerPack, export_pack

LayerPackType = IO.Custom("SOUNDSTAGE_LAYERPACK")
OUTPUT_SUBDIR = "soundstage_layerpacks"


class LayerPackStart(IO.ComfyNode):
    @classmethod
    def define_schema(cls) -> IO.Schema:
        return IO.Schema(
            node_id="SoundstageLayerPackStart",
            display_name="Soundstage · Layer Pack: Start",
            category="Soundstage",
            search_aliases=["layer pack", "layers", "vfx export", "post", "compositing"],
            description="Start a Layer Pack for one shot. Connect the stage's scene_json as the camera so the "
                        "pack carries the exact staged camera for After Effects, Blender and Nuke.",
            inputs=[
                IO.String.Input("shot", default="SH010", tooltip="Shot name; used for the folder and every file."),
                IO.Float.Input("fps", default=24.0, min=1.0, max=240.0, step=0.001),
                IO.Int.Input("frame_start", default=1001, min=0, max=999999,
                             tooltip="First frame number (VFX convention: 1001)."),
                IO.String.Input("camera_json", optional=True, force_input=True,
                                tooltip="Stage scene_json, or {frames:[{position,target,focal_mm}]} per frame."),
                IO.String.Input("notes", default="", multiline=True, optional=True,
                                tooltip="Director notes; become a marker in AE and the OTIO timeline."),
            ],
            outputs=[LayerPackType.Output(display_name="pack")],
        )

    @classmethod
    def execute(cls, shot, fps, frame_start, camera_json=None, notes="") -> IO.NodeOutput:
        return IO.NodeOutput(LayerPack(shot=shot or "SH010", fps=float(fps), frame_start=int(frame_start),
                                       camera=camera_json or None, notes=notes or ""))


class LayerPackAddLayer(IO.ComfyNode):
    @classmethod
    def define_schema(cls) -> IO.Schema:
        return IO.Schema(
            node_id="SoundstageLayerPackAddLayer",
            display_name="Soundstage · Layer Pack: Add Layer",
            category="Soundstage",
            search_aliases=["add layer", "matte", "character layer"],
            description="Add one layer: its frames, its matte (1 = opaque) and where it sits in the stack. "
                        "Higher z is on top. Masks come from upstream (SAM 3 tracks, the stage ID pass, mattes).",
            inputs=[
                LayerPackType.Input("pack"),
                IO.String.Input("name", default="actor_a", tooltip="Layer name, e.g. the stage actor's name."),
                IO.Image.Input("images", tooltip="RGB frames (a single image is held for every frame)."),
                IO.Mask.Input("mask", optional=True, tooltip="Matte per frame. Leave empty for a full-frame plate."),
                IO.Int.Input("z", default=10, min=0, max=999, tooltip="Stack order: 0 = back. Higher = on top."),
                IO.Combo.Input("kind", options=KINDS, default="character"),
                IO.Combo.Input("blend_mode", options=BLEND_MODES, default="normal"),
                IO.Boolean.Input("invert_mask", default=False,
                                 tooltip="Turn on for masks where 1 = transparent (LoadImage alpha)."),
                IO.String.Input("source_id", default="", optional=True,
                                tooltip="Stage actor id or SAM 3 object index, kept in the manifest."),
            ],
            outputs=[LayerPackType.Output(display_name="pack")],
        )

    @classmethod
    def execute(cls, pack, name, images, z, kind, blend_mode, invert_mask, mask=None, source_id="") -> IO.NodeOutput:
        if mask is not None and mask.shape[0] not in (1, images.shape[0]) and images.shape[0] != 1:
            raise ValueError(f"Layer '{name}': {images.shape[0]} frames but {mask.shape[0]} mask frames.")
        return IO.NodeOutput(pack.add_layer(Layer(name=name or "layer", images=images, mask=mask, z=int(z), kind=kind,
                                                  blend_mode=blend_mode, source_id=source_id or "",
                                                  invert_mask=bool(invert_mask))))


MATTE_SOURCES = ["final frames (SAM 3.1 + BiRefNet edges)", "final frames (SAM 3.1)", "stage ID pass"]


def _sam3_ckpts():
    try:
        import folder_paths
        found = [f for f in folder_paths.get_filename_list("checkpoints") if "sam3" in f.lower()]
    except Exception:  # noqa: BLE001 - outside ComfyUI
        found = []
    return found or ["sam3.1_multiplex_fp16.safetensors"]


class LayerPackAddAll(IO.ComfyNode):
    @classmethod
    def define_schema(cls) -> IO.Schema:
        return IO.Schema(
            node_id="SoundstageLayerPackAddAll",
            display_name="Soundstage · Layer Pack: Add All Actors",
            category="Soundstage",
            search_aliases=["add all layers", "per actor layers", "every character", "auto layers"],
            description="Add the background plus one layer per stage actor (riders included). By default each matte "
                        "is cut from the FINAL frames: SAM 3.1 tracks every person/animal/vehicle, the stage's ID pass "
                        "picks which track is which actor, and BiRefNet (core Remove Background) gives the soft edge. "
                        "Actors never on screen are skipped. Stacked far to near; a rider sits right above its mount.",
            inputs=[
                LayerPackType.Input("pack"),
                IO.Image.Input("images", tooltip="Final frames."),
                IO.Image.Input("id_pass", tooltip="The stage's ID pass (one flat colour per actor)."),
                IO.String.Input("scene_json", force_input=True),
                IO.Image.Input("depth", optional=True,
                               tooltip="Stage depth pass (near = white): orders the layers far to near. "
                                       "Without it, stage order is used."),
                IO.Int.Input("grow", default=6, min=0, max=64, tooltip="Pixels to expand each clay silhouette."),
                IO.Int.Input("feather", default=4, min=0, max=64),
                IO.Combo.Input("matte_source", options=MATTE_SOURCES, default=MATTE_SOURCES[0],
                               tooltip="Final frames = mattes that sit on the generated pixels (recommended). "
                                       "Stage ID pass = the clay silhouettes (fast, but LTX moves edges)."),
                IO.Combo.Input("sam3_model", options=_sam3_ckpts(), advanced=True),
            ],
            outputs=[LayerPackType.Output(display_name="pack"), IO.String.Output(display_name="layers")],
        )

    @classmethod
    def execute(cls, pack, images, id_pass, scene_json, grow=6, feather=4, depth=None,
                matte_source=None, sam3_model=None) -> IO.NodeOutput:
        from .layerpack.actors import actor_layers
        scene = json.loads(scene_json) if scene_json else {}
        entries = actor_layers(scene, id_pass, images, depth=depth, grow=int(grow), feather=int(feather))
        source = matte_source or MATTE_SOURCES[0]
        note = ""
        if source != MATTE_SOURCES[2] and len(entries) > 1:
            from .layerpack import final_mattes as FM
            try:
                prompts = FM.prompts_for(scene)
                n_track = sum(1 for e in entries if e["kind"] != "background")
                objs = FM.track_final(images, prompts, sam3_model or _sam3_ckpts()[0], max_objects=n_track + 3) \
                    if prompts else torch.zeros(images.shape[0], 0, images.shape[1], images.shape[2])
                alpha = FM.soft_alpha(images) if source == MATTE_SOURCES[0] else None
                entries = FM.refine(entries, objs, scene, alpha=alpha)
            except Exception as exc:  # noqa: BLE001 - never lose the pack: fall back to the clay mattes
                note = f" (final-frame mattes failed: {exc}; used the stage ID pass)"
        for e in entries:
            pack = pack.add_layer(Layer(name=e["name"], images=images, mask=e["mask"], z=e["z"], kind=e["kind"],
                                        source_id=e["id"]))
        src = ((scene.get("reference") or {}).get("source") or (scene.get("backdrop") or {}).get("source")) \
            if isinstance(scene, dict) else None
        if src and not (pack.meta or {}).get("source"):   # Video -> Stage footage: Export can match its spec
            import dataclasses
            pack = dataclasses.replace(pack, meta={**(pack.meta or {}), "source": src})
        summary = ", ".join(f"{e['name']} (z {e['z']}; {e.get('matte', 'stage ID pass')})" for e in entries) + note
        return IO.NodeOutput(pack, summary, ui={"text": [f"{len(entries)} layers: {summary}"]})


class LayerPackAddAOV(IO.ComfyNode):
    @classmethod
    def define_schema(cls) -> IO.Schema:
        return IO.Schema(
            node_id="SoundstageLayerPackAddAOV",
            display_name="Soundstage · Layer Pack: Add AOV",
            category="Soundstage",
            search_aliases=["depth", "normals", "aov", "pass"],
            description="Add a render pass for the whole frame. Depth is written as a float EXR in metres and "
                        "also sets how far away each layer's card sits in AE, Blender and Nuke.",
            inputs=[
                LayerPackType.Input("pack"),
                IO.Combo.Input("kind", options=AOV_KINDS, default="depth"),
                IO.Image.Input("images"),
                IO.Combo.Input("depth_encoding", options=DEPTH_ENCODINGS, default=DEPTH_ENCODINGS[0],
                               tooltip="Stage depth is near = white, linear between near and far."),
                IO.Float.Input("near", default=1.0, min=0.0, max=10000.0, step=0.01, tooltip="Metres (stage: 1)."),
                IO.Float.Input("far", default=40.0, min=0.01, max=100000.0, step=0.01, tooltip="Metres (stage: 40)."),
                IO.Boolean.Input("conform_to_mattes", default=True, optional=True,
                                 tooltip="Depth: reshape the stage (clay) depth so every actor's silhouette is its "
                                         "final-frame matte, not the clay figure."),
            ],
            outputs=[LayerPackType.Output(display_name="pack")],
        )

    @classmethod
    def execute(cls, pack, kind, images, depth_encoding, near, far, conform_to_mattes=True) -> IO.NodeOutput:
        if kind == "depth" and conform_to_mattes and any(l.kind != "background" for l in pack.layers):
            from .layerpack.final_mattes import conform_depth
            images = conform_depth(images, pack.layers)
        units = "metres" if kind == "depth" and not depth_encoding.startswith("relative") else ""
        return IO.NodeOutput(pack.add_aov(AOV(kind=kind, images=images, units=units, near=float(near),
                                              far=float(far), encoding=depth_encoding if kind == "depth" else "")))


class LayerPackExport(IO.ComfyNode):
    @classmethod
    def define_schema(cls) -> IO.Schema:
        return IO.Schema(
            node_id="SoundstageLayerPackExport",
            display_name="Soundstage · Layer Pack: Export",
            category="Soundstage",
            search_aliases=["export layers", "prores", "psd", "after effects", "nuke", "blender", "otio", "resolve"],
            description="Write the Layer Pack to output/soundstage_layerpacks/<shot>_<time>/: PNG + matte "
                        "sequences, ProRes 4444, a PSD of the hero frame, depth EXR, the camera, and one-click "
                        "builders for After Effects, Blender, Nuke and Resolve.",
            is_output_node=True,
            inputs=[
                LayerPackType.Input("pack"),
                IO.Boolean.Input("prores_4444", default=True, tooltip="One ProRes 4444 .mov with alpha per layer."),
                IO.Boolean.Input("psd", default=True, tooltip="Layered Photoshop file of the hero frame."),
                IO.Boolean.Input("app_builders", default=True,
                                 tooltip="Camera files + After Effects, Blender and Nuke scripts."),
                IO.Boolean.Input("otio", default=True, tooltip="OpenTimelineIO timeline, one track per layer."),
                IO.Boolean.Input("multilayer_exr", default=False,
                                 tooltip="One multi-layer EXR per frame (beauty + every layer + depth) for Nuke."),
                IO.Int.Input("hero_frame", default=-1, min=-1, max=100000,
                             tooltip="Frame index (0 = first) for the PSD and preview; -1 = middle frame."),
                IO.Boolean.Input("match_source", default=True, optional=True,
                                 tooltip="Deliver at the source footage's spec: its resolution (lanczos), frame rate "
                                         "and timecode, Rec.709 tags. Anything that can't match is written in the "
                                         "manifest and README. Uses the Video -> Stage clip, or source_spec."),
                IO.String.Input("source_spec", optional=True, force_input=True,
                                tooltip="Source spec JSON (GET /soundstage/source_spec). Optional: a Video -> Stage "
                                        "scene already carries it."),
            ],
            outputs=[
                IO.String.Output(display_name="folder"),
                IO.Image.Output(display_name="preview"),
            ],
        )

    @classmethod
    def execute(cls, pack, prores_4444, psd, app_builders, otio, multilayer_exr, hero_frame, match_source=True,
                source_spec=None) -> IO.NodeOutput:
        out_dir = os.path.join(folder_paths.get_output_directory(), OUTPUT_SUBDIR)
        res = export_pack(pack, out_dir, hero_frame=int(hero_frame), prores=bool(prores_4444), psd=bool(psd),
                          camera=bool(app_builders), ae=bool(app_builders), blender=bool(app_builders),
                          nuke=bool(app_builders), otio=bool(otio), multilayer_exr=bool(multilayer_exr),
                          match_source=match_source is not False, source=source_spec or None)
        preview = torch.from_numpy(res["preview"])[None]
        failed = {k: v for k, v in res["manifest"]["exports"].items() if v != "ok"}
        summary = f"Layer Pack written: {res['root']}"
        if failed:
            summary += "\n" + "\n".join(f"{k}: {v}" for k, v in failed.items())
        dl = res["manifest"].get("delivery") or {}
        if dl.get("matched"):
            summary += "\n" + ((dl.get("source") or {}).get("line") or "Delivered at source spec")
        summary += "".join(f"\n- {n}" for n in dl.get("notes") or [])
        ui = UI.PreviewImage(preview, cls=cls).as_dict()
        ui["text"] = [summary]
        return IO.NodeOutput(res["root"], preview, ui=ui)


NODES = [LayerPackStart, LayerPackAddLayer, LayerPackAddAll, LayerPackAddAOV, LayerPackExport]
