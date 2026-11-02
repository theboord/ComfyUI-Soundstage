#!/usr/bin/env python3
"""Download the models in MODELS.md into any models folder, including one on an external drive.

    python tools/fetch_models.py /Volumes/Models/ComfyUI-models              # everything
    python tools/fetch_models.py /path/to/ComfyUI/models --groups klein krea
    python tools/fetch_models.py /Volumes/Models/ComfyUI-models --dry-run     # what would download
    python tools/fetch_models.py /Volumes/Models/ComfyUI-models --verify      # check what is there

Same files as tools/install_runpod.sh, plus three it does not fetch: FLUX 3 Klein and the
FLUX.2 VAE (the App's default image model) and whisper-base (offline Director voice).

What it adds over a plain `hf download`:
  * a file counts as present only if it is complete. A .safetensors file is checked against
    its own header (size == 8 + header + last tensor end), so a download cut short is fetched
    again instead of being skipped because it is non-empty;
  * the Hugging Face cache sits next to the models (`.soundstage_staging/`), so a 60 GB fetch
    does not fill the internal disk. It is passed as cache_dir, not HF_HOME: moving HF_HOME
    also hides the saved login token, and every gated repo then answers "access denied";
  * files are verified in staging and only then moved into place, so ComfyUI never lists half a file;
  * on macOS it removes the `._name` sidecars that exFAT/FAT drives collect, which otherwise
    show up in ComfyUI's model lists and fail to load;
  * a gated repo that has not been accepted gets the licence page to open, not a stack trace.

Needs `huggingface_hub` (pip install "huggingface_hub>=0.30"). Gated repos: accept the licence on
huggingface.co, then `hf auth login` (or set HF_TOKEN). Licences are listed in MODELS.md.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import struct
import sys
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Model:
    group: str
    repo: str
    path: str               # file in the repo, or a folder when `folder` is set
    subdir: str             # folder under models/
    name: str = ""          # saved name, when it differs from the repo's
    folder: bool = False    # a whole Hugging Face repo saved as a folder (whisper)
    patterns: tuple = ()    # files to take from a folder repo
    also: tuple = ()        # other names MODELS.md accepts for the same file

    @property
    def saved_name(self) -> str:
        return self.name or os.path.basename(self.path)

    def target(self, models_dir: Path) -> Path:
        return models_dir / self.subdir / self.saved_name

    def existing(self, models_dir: Path) -> Path:
        """The copy on disk to judge: a complete one under any accepted name first, then any copy,
        then the saved name (so an accepted other name is not fetched twice)."""
        paths = [models_dir / self.subdir / n for n in (self.saved_name, *self.also)]
        present = [p for p in paths if p.exists()]
        for p in present:
            if p.suffix != ".safetensors" or check_safetensors(p) is None:
                return p
        return present[0] if present else self.target(models_dir)


# Groups follow MODELS.md: klein = first frame / cast sheets (default), krea = Look still,
# ltx = Motion, llm = object designer + scene agent + Director, whisper = offline Director voice.
MANIFEST = (
    Model("klein", "black-forest-labs/flux-3-image-klein-comfy",
          "diffusion_models/flux3-image-klein-int8-convrot.safetensors", "diffusion_models"),
    Model("klein", "Comfy-Org/Krea-2", "text_encoders/qwen3vl_4b_fp8_scaled.safetensors", "text_encoders",
          also=("qwen3vl_4b_int8_convrot.safetensors",)),
    Model("klein", "Comfy-Org/flux2-dev", "split_files/vae/flux2-vae.safetensors", "vae"),
    Model("krea", "Comfy-Org/Krea-2", "diffusion_models/krea2_turbo_fp8_scaled.safetensors",
          "diffusion_models", name="Krea-2-Turbo.safetensors", also=("krea2_turbo_fp8_scaled.safetensors",)),
    Model("krea", "Comfy-Org/Krea-2", "text_encoders/qwen3vl_4b_fp8_scaled.safetensors", "text_encoders",
          also=("qwen3vl_4b_int8_convrot.safetensors",)),
    Model("krea", "Comfy-Org/Krea-2", "vae/qwen_image_vae.safetensors", "vae"),
    Model("krea", "Patil/Krea-2-depth-controlnet", "depth-control-lora.safetensors", "loras/krea2/cn"),
    Model("ltx", "Lightricks/LTX-2.5",
          "diffusion_models/ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors", "diffusion_models"),
    Model("ltx", "Lightricks/LTX-2.5",
          "text_encoders/gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors", "text_encoders"),
    Model("ltx", "Lightricks/LTX-2.5", "vae/ltx-2.5-video-vae-bf16.safetensors", "vae"),
    Model("ltx", "Lightricks/LTX-2.5", "vae/ltx-2.5-audio-vae-bf16.safetensors", "vae"),
    Model("ltx", "Lightricks/LTX-2.5",
          "latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors", "latent_upscale_models"),
    Model("ltx", "Lightricks/LTX-2.5-22b-IC-LoRA-Layout-To-Render",
          "ltx-2.5-22b-ic-lora-layout-to-render-1.0.safetensors", "loras/ltx2.5"),
    Model("llm", "Comfy-Org/Qwen3.5", "text_encoders/qwen3.5_4b_bf16.safetensors", "text_encoders"),
    Model("whisper", "openai/whisper-base", "", "whisper", name="whisper-base", folder=True,
          patterns=("*.json", "*.txt", "model.safetensors")),
)
GROUPS = ("klein", "krea", "ltx", "llm", "whisper")
STAGING = ".soundstage_staging"


def select(groups) -> list[Model]:
    """Models in the chosen groups, each target once (Klein and Krea share a text encoder)."""
    seen, picked = set(), []
    for m in MANIFEST:
        if m.group in groups and (m.subdir, m.saved_name) not in seen:
            seen.add((m.subdir, m.saved_name))
            picked.append(m)
    return picked


def check_safetensors(path: Path) -> str | None:
    """None when the file is a complete .safetensors, else what is wrong with it."""
    try:
        size = path.stat().st_size
        with open(path, "rb") as f:
            raw = f.read(8)
            if len(raw) < 8:
                return "shorter than a header"
            (header_len,) = struct.unpack("<Q", raw)
            if header_len <= 0 or 8 + header_len > size:
                return "header runs past the end of the file"
            header = json.loads(f.read(header_len))
    except (OSError, ValueError) as e:
        return f"unreadable ({e.__class__.__name__})"
    try:  # a header that parses as JSON but is not a safetensors header must not crash a --verify run
        ends = [t["data_offsets"][1] for k, t in header.items() if k != "__metadata__"]
        expected = 8 + header_len + max(ends, default=0)
    except (AttributeError, KeyError, IndexError, TypeError):
        return "header is not a valid safetensors header"
    if size != expected:
        return f"{size} bytes, header says {expected} (cut short?)" if size < expected else \
               f"{size} bytes, header says {expected}"
    return None


def check(m: Model, models_dir: Path) -> str | None:
    """None when the model is fully present, else the reason it is not."""
    target = m.existing(models_dir)
    if m.folder:
        weights = target / "model.safetensors"
        if not weights.is_file():
            return "missing"
        return check_safetensors(weights)
    if not target.is_file():
        return "missing"
    if target.suffix == ".safetensors":
        return check_safetensors(target)
    return None if target.stat().st_size > 0 else "empty"


def remove_appledouble(directory: Path) -> int:
    """Delete the `._name` sidecars macOS writes on exFAT/FAT drives; ComfyUI lists them as models.
    Only a `._name` whose `name` sits beside it is a sidecar; anything else is left alone."""
    if sys.platform != "darwin" or not directory.is_dir():
        return 0
    removed = 0
    for p in directory.rglob("._*"):
        if p.is_file() and (p.parent / p.name[2:]).exists():
            p.unlink()
            removed += 1
    return removed


def gated_hint(error: Exception, repo: str) -> str | None:
    """A readable line for the errors people actually hit, or None to show the raw error."""
    text = f"{error.__class__.__name__}: {error}"
    if "GatedRepo" in text or "requires approval" in text or re.search(r"\b403\b", text):
        return (f"{repo} is gated: accept the licence at https://huggingface.co/{repo}, "
                f"then `hf auth login` (or set HF_TOKEN) and run this again.")
    if re.search(r"\b401\b", text) or "Unauthorized" in text:
        return f"{repo}: not logged in. Run `hf auth login` (or set HF_TOKEN) and run this again."
    return None


def download(m: Model, models_dir: Path, staging: Path) -> Path:
    """Fetch one model into staging and return the staged path. Kept separate so tests can swap it."""
    from huggingface_hub import hf_hub_download, snapshot_download
    cache = staging / "hf_cache"
    if m.folder:
        out = staging / "folders" / m.saved_name
        snapshot_download(m.repo, local_dir=out, cache_dir=cache, allow_patterns=list(m.patterns))
        shutil.rmtree(out / ".cache", ignore_errors=True)  # download bookkeeping, not part of the model
        return out
    out = staging / "files"
    return Path(hf_hub_download(m.repo, m.path, local_dir=out, cache_dir=cache))


def fetch(m: Model, models_dir: Path, staging: Path, downloader=download) -> str:
    """Download, verify in staging, then move into place. Returns a one-line status."""
    staged = downloader(m, models_dir, staging)
    weights = staged / "model.safetensors" if m.folder else staged
    if weights.suffix == ".safetensors":
        problem = check_safetensors(weights)
        if problem:
            raise RuntimeError(f"downloaded file is incomplete: {problem}")
    target = m.target(models_dir)
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():  # an incomplete earlier copy
        shutil.rmtree(target) if target.is_dir() else target.unlink()
    shutil.move(str(staged), str(target))
    return "done"


def extra_paths_snippet(models_dir: Path) -> str:
    """extra_model_paths.yaml lines that point ComfyUI at a models folder outside its own."""
    folders = sorted({m.subdir.split("/")[0] for m in MANIFEST})
    lines = ["soundstage_models:", f"    base_path: {models_dir}"]
    lines += [f"    {f}: {f}/" for f in folders]
    return "\n".join(lines)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("models_dir", type=Path, help="ComfyUI models folder, or one on another drive")
    ap.add_argument("--groups", nargs="+", choices=GROUPS, default=list(GROUPS))
    ap.add_argument("--dry-run", action="store_true", help="list what would download, fetch nothing")
    ap.add_argument("--verify", action="store_true", help="only check what is already there")
    ap.add_argument("--print-extra-paths", action="store_true",
                    help="print the extra_model_paths.yaml entry for this folder and exit")
    args = ap.parse_args(argv)
    models_dir = args.models_dir.expanduser().resolve()
    if not models_dir.parent.is_dir():
        # most often an external drive that is not mounted: creating the path would put
        # 60 GB on the internal disk instead
        print(f"{models_dir.parent} does not exist. Is the drive mounted?", file=sys.stderr)
        return 2

    if args.print_extra_paths:
        print(extra_paths_snippet(models_dir))
        return 0

    staging = models_dir / STAGING
    failed = 0
    for m in select(args.groups):
        label = f"{m.subdir}/{m.saved_name}"
        problem = check(m, models_dir)
        if problem is None:
            found = m.existing(models_dir).name
            print(f"   have {label}" + ("" if found == m.saved_name else f" (as {found})"))
            continue
        if args.verify or args.dry_run:
            print(f"   {'need' if args.dry_run else 'BAD '} {label} ({problem})")
            failed += args.verify
            continue
        print(f"   get  {label}" + ("" if problem == "missing" else f" (was {problem})"), flush=True)
        try:
            print(f"   {fetch(m, models_dir, staging)} {label}")
        except Exception as e:  # keep going: one gated repo should not stop the rest
            failed += 1
            print(f"   FAIL {label}: {gated_hint(e, m.repo) or e}")

    if not (args.verify or args.dry_run):
        shutil.rmtree(staging / "files", ignore_errors=True)
        shutil.rmtree(staging / "folders", ignore_errors=True)
        if not failed:  # keep the cache after a failure so a re-run resumes instead of restarting
            shutil.rmtree(staging, ignore_errors=True)
        removed = remove_appledouble(models_dir)
        if removed:
            print(f"   removed {removed} macOS ._ sidecar files")
    print(f"{failed} problem(s)." if failed else "All present and complete.")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
