"""Soundstage: an open-source film set inside ComfyUI."""
try:
    from .soundstage.nodes_stage import SoundstageExtension
except ImportError:  # imported bare (pytest collecting the pack root), not as a ComfyUI package
    SoundstageExtension = None

try:
    from .soundstage import routes as _routes  # noqa: F401  (registers /soundstage/* HTTP routes)
except ImportError:
    pass

# Optional feature routes (each module exposes an idempotent register()).
for _mod in ("vcam", "agent.routes", "cine.routes", "assets3d.routes", "layerpack.download", "floorplan.routes", "video2stage.routes", "cut.assemble", "takecheck.routes", "presets_agent", "book.routes"):
    try:
        import importlib as _il
        _il.import_module(f"{__name__}.soundstage.{_mod}").register()
    except ImportError:
        pass
    except Exception as _e:  # never let one feature stop the pack loading
        import logging as _lg
        _lg.exception("Soundstage: could not register %s routes: %s", _mod, _e)

WEB_DIRECTORY = "./web"


async def comfy_entrypoint():
    return SoundstageExtension()
