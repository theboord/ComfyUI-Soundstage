"""Where a take's check results live: user/soundstage/takecheck/<key>.<part>.json, keyed by the file's path, size
and modification time (a re-render under the same name is checked again)."""
from __future__ import annotations

import hashlib
import json
import os

_BASE: list[str] = []


def base_dir() -> str:
    if _BASE:
        return _BASE[0]
    import folder_paths
    return os.path.join(folder_paths.get_user_directory(), "soundstage", "takecheck")


def set_base(path: str) -> None:
    """Tests: keep results in a temporary folder."""
    _BASE[:] = [path]


def key(path: str) -> str:
    st = os.stat(path)
    raw = f"{os.path.abspath(path)}|{st.st_size}|{int(st.st_mtime)}"
    return hashlib.sha1(raw.encode()).hexdigest()[:20]


def _file(path: str, part: str) -> str:
    d = base_dir()
    os.makedirs(d, exist_ok=True)
    return os.path.join(d, f"{key(path)}.{part}.json")


def load(path: str, part: str) -> dict | None:
    try:
        with open(_file(path, part)) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def save(path: str, part: str, data: dict) -> None:
    f = _file(path, part)
    tmp = f + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(data, fh)
    os.replace(tmp, f)
