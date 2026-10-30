"""Write a whole Cut export folder: every NLE format, the AAF when pyaaf2 is there, the audio mixdowns."""
import json
import os

from . import aaf
from .export import export_all, normalize_project, safe_name


def write_cut(project, out_dir, name="", media_root="", roots=None, reel_width=8, mixdown=True) -> dict:
    """
    Write <out_dir>/<name>/ (the same folder every time, so paths stay predictable) and return a summary:
    {"folder", "files": [...], "aaf": path | None, "aaf_error": str | None, "mix_index": path | None, "mix": index | None}.
    media_root: absolute prefix for render paths (the ComfyUI output folder). roots: {"output","input","temp"}
    folders for finding audio files; defaults to {"output": media_root}.
    """
    project = normalize_project(project)
    if name:
        project["name"] = name
    folder = os.path.join(out_dir, safe_name(project["name"]))
    os.makedirs(folder, exist_ok=True)
    files = []
    for fname, text in export_all(project, media_root=media_root, reel_width=reel_width).items():
        latin1 = fname.endswith("_avid_locators.txt")  # Avid reads marker files as Latin-1
        with open(os.path.join(folder, fname), "w", encoding="latin-1" if latin1 else "utf-8",
                  errors="replace", newline="\n") as f:
            f.write(text)
        files.append(fname)
    summary = {"folder": folder, "files": files, "aaf": None, "aaf_error": None, "mix_index": None, "mix": None}

    aaf_name = f"{safe_name(project['name'])}.aaf"
    if aaf.available():
        try:
            summary["aaf"] = aaf.write_aaf(os.path.join(folder, aaf_name), project, media_root)
            files.append(aaf_name)
        except Exception as e:  # noqa: BLE001  (the other formats are still good)
            summary["aaf_error"] = f"AAF failed: {e}"
    else:
        summary["aaf_error"] = "pyaaf2 is not installed (pip install pyaaf2); use the EDL + locator file for Avid"

    if mixdown:
        try:
            from .mix import write_mixdown
            summary["mix"] = write_mixdown(project, folder, roots or {"output": media_root})
            summary["mix_index"] = os.path.join(folder, "audio", "index.json")
        except ImportError as e:
            summary["mix_error"] = f"mixdown needs numpy: {e}"

    with open(os.path.join(folder, "project.json"), "w", encoding="utf-8") as f:
        json.dump(project, f, indent=2, ensure_ascii=False)
    files.append("project.json")
    return summary
