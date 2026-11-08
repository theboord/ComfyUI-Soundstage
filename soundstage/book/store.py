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


def save(book: dict, name: str = "current", project: dict | None = None) -> str:
    """Write a book. project = {id, name}: the project it belongs to, kept as book["_project"] so Forget can tell this
    project's book from another's (forget())."""
    os.makedirs(books_dir(), exist_ok=True)
    if isinstance(project, dict) and (project.get("id") or project.get("name")):
        book = {**book, "_project": {k: str(project[k])[:120] for k in ("id", "name") if project.get(k)}}
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


# ------------------------------------------------------------------------------------------------ forget a decision

MAX_SCRUB_BYTES = 64 * 1024 * 1024


def _strip(obj, ids: set) -> int:
    """Remove chat decision notes whose id (or ref) is in ids from every "notes" list inside obj. Returns how many."""
    n = 0
    if isinstance(obj, dict):
        notes = obj.get("notes")
        if isinstance(notes, list):
            keep = [x for x in notes if not (isinstance(x, dict) and x.get("source") == "chat"
                                             and (x.get("id") in ids or (x.get("ref") is not None and x.get("ref") in ids)))]
            if len(keep) != len(notes):
                n += len(notes) - len(keep)
                obj["notes"] = keep
        for k, v in obj.items():
            if k != "notes":
                n += _strip(v, ids)
    elif isinstance(obj, list):
        for v in obj:
            n += _strip(v, ids)
    return n


def _json_files(root: str):
    for d, dirs, files in os.walk(root):
        dirs[:] = [x for x in dirs if not os.path.islink(os.path.join(d, x))]
        for f in files:
            if f.endswith((".json", ".json.tmp")):         # *.json.tmp: a save that died before its rename
                p = os.path.join(d, f)
                if not os.path.islink(p):
                    yield p


def _ident(data) -> tuple[str | None, str | None]:
    """(project id, project name) a stored file belongs to, from what it carries: a workflow's extra.ss_project, an
    autosave's {name, workflow}, a manifest's {format: soundstage-project, id, name}, a server book's _project.
    (None, None) when the file says nothing about its project."""
    if not isinstance(data, dict):
        return None, None
    def ok_id(i):
        return i if isinstance(i, str) and len(i) == 10 and i.startswith("p_") and all(c in "0123456789abcdef" for c in i[2:]) else None
    def ok_name(n):
        return n.strip() if isinstance(n, str) and n.strip() else None
    sp = (data.get("extra") or {}).get("ss_project") if isinstance(data.get("extra"), dict) else None
    if isinstance(sp, dict):
        return ok_id(sp.get("id")), ok_name(sp.get("name"))
    if isinstance(data.get("workflow"), dict):                    # an autosave
        i, n = _ident(data["workflow"])
        return i, n or ok_name(data.get("name"))
    if str(data.get("format", "")).startswith("soundstage-project"):  # a manifest
        return ok_id(data.get("id")), ok_name(data.get("name"))
    if isinstance(data.get("_project"), dict):                    # a server book saved with its project
        return ok_id(data["_project"].get("id")), ok_name(data["_project"].get("name"))
    return None, None


def _in_scope(fid, fname, pid, pname) -> bool | None:
    """Is a file of project (fid, fname) one of the forgetting project's (pid, pname)? None: the file names no project.
    Same id -> yes, a different id -> no; a file without an id (saved before ids existed) -> by name."""
    if fid is None and fname is None:
        return None
    if pid and fid:
        return fid == pid
    return bool(pname) and fname == pname


def forget(ids, roots, project=None) -> dict:
    """Remove chat decision notes (by note id or ref) from every stored copy OF ONE PROJECT: project = {id, name} (the
    project the Forget came from). Scanned: the books folder (current.json, any other book, and leftover *.json.tmp)
    and each folder in roots (the user's workflows/ and projects/: saved workflows, manifests, autosaves, the trash,
    *.json.tmp leftovers). A file counts as the project's when it carries the same project id, or no id and the same
    project name (saved before ids existed); a server book with no _project is the open book and counts too. Files of
    another project (a Duplicate, a Save As copy) are left alone and listed in other_projects. Only files whose text
    mentions an id are parsed; changed files are rewritten atomically.
    Returns {ok, removed, files: [paths changed], still_mentions: [the project's paths whose text still holds an id,
    e.g. inside a string], skipped: [{path, why}]: files that mention an id but were not cleaned (too big, or not tied
    to any project), other_projects: [paths], errors: [...]}. ok is False when skipped, still_mentions or errors is
    non-empty: then not every copy is gone, and the caller must say so."""
    ids = {str(i) for i in (ids or []) if isinstance(i, str) and i.strip()}
    out = {"ok": True, "removed": 0, "files": [], "still_mentions": [], "skipped": [], "other_projects": [], "errors": []}
    if not ids:
        return out
    project = project if isinstance(project, dict) else {}
    pid = project.get("id") if isinstance(project.get("id"), str) and project.get("id") else None
    pname = project.get("name").strip() if isinstance(project.get("name"), str) and project.get("name").strip() else None
    if not pid and not pname:
        out["skipped"].append({"path": "*", "why": "no project given: only the open book (books/current.json) was cleaned"})
    seen = set()
    bdir = os.path.realpath(books_dir())
    for root in [books_dir(), *[str(r) for r in roots or [] if r]]:
        if not os.path.isdir(root):
            continue
        for p in _json_files(root):
            rp = os.path.realpath(p)
            if rp in seen:
                continue
            seen.add(rp)
            in_books = os.path.dirname(rp) == bdir
            try:
                if os.path.getsize(p) > MAX_SCRUB_BYTES:
                    out["skipped"].append({"path": p, "why": f"over {MAX_SCRUB_BYTES // (1024 * 1024)} MB, not read"})
                    continue
                with open(p, encoding="utf-8") as f:
                    text = f.read()
                if not any(i in text for i in ids):
                    continue
                data = json.loads(text)
                scope = _in_scope(*_ident(data), pid, pname)
                if scope is None and in_books and os.path.basename(p).split(".")[0] == "current":
                    scope = True                      # the open book, saved before books carried their project
                if scope is None and not pid and not pname:
                    continue                          # reported once above
                if scope is None:
                    out["skipped"].append({"path": p, "why": "mentions the id but names no project, so it was not changed"})
                    continue
                if not scope:
                    out["other_projects"].append(p)
                    continue
                k = _strip(data, ids)
                if k:
                    tmp = p + ".forget.tmp"
                    with open(tmp, "w", encoding="utf-8") as f:
                        json.dump(data, f, ensure_ascii=False)
                    os.replace(tmp, p)
                    out["removed"] += k
                    out["files"].append(p)
                    text = json.dumps(data, ensure_ascii=False)
                if any(i in text for i in ids):
                    out["still_mentions"].append(p)
            except (OSError, ValueError) as e:
                out["errors"].append(f"{p}: {e}")
    out["ok"] = not (out["errors"] or out["skipped"] or out["still_mentions"])
    if not out["ok"]:
        n = len(out["errors"]) + len(out["skipped"]) + len(out["still_mentions"])
        out["error"] = f"{n} stored cop{'y' if n == 1 else 'ies'} not cleaned: " + "; ".join(
            [*out["errors"], *[f"{s['path']} ({s['why']})" for s in out["skipped"]], *[f"{q} (still mentions it)" for q in out["still_mentions"]]])[:600]
    return out
