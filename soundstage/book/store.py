"""Where the Director's Book lives on the server: ComfyUI's user data (user/default/soundstage/books/current.json).

The App also keeps it in the workflow (node.properties.ss_book), so a saved workflow carries its book. The server copy
is what the MCP bridge and the Pitch agent read and write between App sessions (routes.py: /soundstage/book/*).
"""
from __future__ import annotations

import json
import os
import time
import uuid

_OVERRIDE: str | None = None     # tests point this at a temp dir


def books_dir() -> str:
    if _OVERRIDE:
        return _OVERRIDE
    try:
        import folder_paths
        base = folder_paths.get_user_directory()
    except Exception:  # noqa: BLE001 - outside ComfyUI
        base = os.path.join(os.path.expanduser("~"), ".soundstage", "user")
    return os.path.join(base, "default", "soundstage", "books")


def _path(name: str = "current") -> str:
    safe = "".join(c for c in str(name or "current") if c.isalnum() or c in "-_") or "current"
    return os.path.join(books_dir(), f"{safe}.json")


def load(name: str = "current") -> dict | None:
    try:
        with open(_path(name), encoding="utf-8") as f:
            b = json.load(f)
        return b if isinstance(b, dict) else None
    except (OSError, ValueError):
        return None


def save(book: dict, name: str = "current") -> str:
    os.makedirs(books_dir(), exist_ok=True)
    p = _path(name)
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(book, f, ensure_ascii=False)
    os.replace(tmp, p)
    return p


def add_note(note: dict, name: str = "current") -> dict:
    """Append a note (a chat decision, a Pitch note) to the stored book. Returns the stored note."""
    book = load(name) or {"v": 1, "notes": []}
    n = {"id": note.get("id") or f"n_{uuid.uuid4().hex[:8]}", "at": note.get("at") or int(time.time() * 1000), **note}
    book.setdefault("notes", []).append(n)
    book["notes"] = book["notes"][-400:]
    save(book, name)
    return n
