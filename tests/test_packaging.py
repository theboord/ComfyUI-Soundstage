"""Comfy Registry / ComfyUI-Manager packaging: pyproject metadata, requirements, the publish action, the archive.

Nothing here publishes. `comfy node validate` (comfy-cli) runs the Registry's own checks; this keeps the parts we
control consistent so a Manager install, a Registry install and `pip install -r requirements.txt` agree.
"""
import fnmatch
import os
import re
import subprocess
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

try:
    import tomllib
except ModuleNotFoundError:  # Python 3.10
    tomllib = pytest.importorskip("tomli")

from soundstage import doctor as D  # noqa: E402

PYPROJECT = tomllib.load(open(os.path.join(ROOT, "pyproject.toml"), "rb"))


def _req_lines():
    out = {}
    for line in open(os.path.join(ROOT, "requirements.txt"), encoding="utf-8"):
        line = line.split("#", 1)[0].strip()
        if line:
            name = re.split(r"[<>=!~\[ ]", line, maxsplit=1)[0].lower()
            out[name] = line.replace(" ", "")
    return out


def _dep_map(deps):
    return {re.split(r"[<>=!~\[ ]", d, maxsplit=1)[0].lower(): d.replace(" ", "") for d in deps}


def test_project_metadata_is_what_the_registry_reads():
    p = PYPROJECT["project"]
    assert re.fullmatch(r"[a-z0-9][a-z0-9-]*", p["name"])  # the Registry node id
    assert re.fullmatch(r"\d+\.\d+\.\d+", p["version"])
    assert p["license"] == {"file": "LICENSE"} and os.path.isfile(os.path.join(ROOT, "LICENSE"))
    assert p["urls"]["Repository"].startswith("https://github.com/theboord/")
    for c in p["classifiers"]:
        assert c.startswith(("Operating System :: POSIX", "Environment :: GPU :: NVIDIA CUDA")), c


def test_tool_comfy_block():
    c = PYPROJECT["tool"]["comfy"]
    assert "PublisherId" in c  # empty until Mike picks the publisher; the publish action is manual
    assert c["DisplayName"] == "Soundstage"
    assert c["Icon"].startswith("https://") and c["Icon"].endswith("docs/icon.svg")
    assert os.path.isfile(os.path.join(ROOT, "docs", "icon.svg"))
    assert c["includes"] == []  # includes would override .comfyignore and ship docs/media
    assert c["requires-comfyui"] == f">={D.TESTED_COMFYUI}"


def test_requirements_and_pyproject_agree():
    req = _req_lines()
    deps = _dep_map(PYPROJECT["project"]["dependencies"])
    opt = {}
    for group in PYPROJECT["project"].get("optional-dependencies", {}).values():
        opt.update(_dep_map(group))
    for name, spec in deps.items():
        assert req.get(name) == spec, f"{name}: pyproject {spec} vs requirements.txt {req.get(name)}"
    for name, spec in req.items():
        assert (deps.get(name) or opt.get(name)) == spec, f"requirements.txt {spec} is not in pyproject.toml"


def test_the_doctor_checks_every_requirement():
    import_names = {"soundfile": "soundfile", "opencv-python-headless": "cv2", "scipy": "scipy", "pyaaf2": "aaf2"}
    checked = {pip for _, pip, _, _ in D.DEPS}
    for name in _req_lines():
        assert name in checked, f"doctor.DEPS does not check {name}"
        assert name in import_names


def test_publish_action_is_manual_and_uses_the_secret():
    src = open(os.path.join(ROOT, ".github", "workflows", "publish_action.yml"), encoding="utf-8").read()
    on = src.split("\non:", 1)[1].split("\njobs:", 1)[0]
    assert "workflow_dispatch" in on and "push" not in on and "pull_request" not in on
    assert "secrets.REGISTRY_ACCESS_TOKEN" in src and "Comfy-Org/publish-node-action" in src


def _ignored(path, patterns):
    for pat in patterns:
        if pat.endswith("/") and (path + "/").startswith(pat):
            return True
        if fnmatch.fnmatch(path, pat):
            return True
    return False


def test_archive_keeps_what_runs_and_drops_the_heavy_media():
    pats = [l.strip() for l in open(os.path.join(ROOT, ".comfyignore"), encoding="utf-8")
            if l.strip() and not l.startswith("#")]
    try:
        files = subprocess.check_output(["git", "-C", ROOT, "ls-files"], text=True).splitlines()
    except (OSError, subprocess.CalledProcessError):
        pytest.skip("no git")
    shipped = [f for f in files if not _ignored(f, pats)]
    assert not [f for f in shipped if f.startswith("docs/media/")]
    for must in ("__init__.py", "requirements.txt", "pyproject.toml", "LICENSE", "MODELS.md", "README.md",
                 "web/soundstage.js", "soundstage/nodes_stage.py", "example_workflows/Soundstage_App_Full.json"):
        assert must in shipped, must
    size = sum(os.path.getsize(os.path.join(ROOT, f)) for f in shipped if os.path.isfile(os.path.join(ROOT, f)))
    assert size < 40 * 2**20, f"the Registry archive would hold {size / 2**20:.0f} MB"
