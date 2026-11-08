"""Where the Director's Book lives on the server: ComfyUI's user data (user/default/soundstage/books/current.json).

The App also keeps it in the workflow (node.properties.ss_book), so a saved workflow carries its book. The server copy
is what the MCP bridge and the Pitch agent read and write between App sessions (routes.py: /soundstage/book/*).
"""
from __future__ import annotations

import json
import os
import re
import time
import unicodedata
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
# Note sources Forget removes (web/book/model.mjs FORGETTABLE_SOURCES): "chat" (the Director / Ask decisions,
# recordDecision) and "ask" (notes Ask added through book.addNote(text, {source: "ask", ref})). Never the director's
# own notes, Pitch's or the rules'.
FORGETTABLE = ("chat", "ask")
DECISION_REF_RE = re.compile(r"^(?:p_[0-9a-f]{8})?:[A-Za-z0-9_-]{1,48}$")
_INVISIBLE = re.compile("[\u00ad\u034f\u180e\u200b-\u200d\u2060\ufeff]")


def _squash(s) -> str:
    """NFKC, invisible characters removed, lowercase, letters and digits only (web/book/model.mjs squash)."""
    t = _INVISIBLE.sub("", unicodedata.normalize("NFKC", str(s or ""))).lower()
    return "".join(c for c in t if c.isalnum())


def clean_ref(ref, text: str = "") -> str | None:
    """A note's ref as the server keeps it, or None: the opaque `${projectId}:${turnId}` shape only, and never a turn id
    that spells out the note's text (squashed, 8+ letters)."""
    r = str(ref).strip() if isinstance(ref, str) else ""
    if not DECISION_REF_RE.match(r):
        return None
    turn = _squash(r.split(":", 1)[1])
    t = _squash(text)
    if t and len(turn) >= 8 and (turn in t or t in turn):
        return None
    return r


def _strip(obj, ids: set) -> int:
    """Remove chat decision notes and Ask's notes (FORGETTABLE) whose id (or ref) is in ids from every "notes" list
    inside obj. Returns how many."""
    n = 0
    if isinstance(obj, dict):
        notes = obj.get("notes")
        if isinstance(notes, list):
            keep = [x for x in notes if not (isinstance(x, dict) and x.get("source") in FORGETTABLE
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


def _folder_of(root: str, p: str) -> str | None:
    """The projects/<name>/ folder a file sits in, when root is the user's projects/ folder; else None. The trash
    (projects/.trash/) is not a project folder."""
    if os.path.basename(os.path.normpath(root)) != "projects":
        return None
    rel = os.path.relpath(p, root).split(os.sep)
    return rel[0] if len(rel) > 1 and not rel[0].startswith(".") else None


COLLECTED_ROOT = "soundstage_projects"      # output/soundstage_projects/ (soundstage/project/collect.py ROOT_NAME)


def _collected_folder_of(root: str, p: str) -> str | None:
    """The output/soundstage_projects/<name>/ folder a file sits in, when root is that collected-projects folder."""
    if os.path.basename(os.path.normpath(root)) != COLLECTED_ROOT:
        return None
    rel = os.path.relpath(p, root).split(os.sep)
    return rel[0] if len(rel) > 1 and not rel[0].startswith(".") else None


def _own_workflow(root: str, p: str, pfolder: str | None) -> bool:
    """Is p the project's own saved workflow, workflows/<name>.json (ProjectStore.workflowPath)? That file is the
    project's whatever id it carries: two tabs saving at once can leave it with another id than project.json."""
    if not pfolder or os.path.basename(os.path.normpath(root)) != "workflows":
        return False
    return os.path.relpath(p, root) in (pfolder + ".json", pfolder + ".json.tmp")


def _chat_notes(obj):
    """Every forgettable note (a dict with source "chat" or "ask") in any "notes" list inside obj."""
    if isinstance(obj, dict):
        notes = obj.get("notes")
        if isinstance(notes, list):
            for x in notes:
                if isinstance(x, dict) and x.get("source") in FORGETTABLE:
                    yield x
        for k, v in obj.items():
            if k != "notes":
                yield from _chat_notes(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from _chat_notes(v)


def forget(ids, roots, project=None, everywhere=False) -> dict:
    """Remove chat decision notes (by note id or ref) from every stored copy OF ONE PROJECT: project = {id, name} (the
    project the Forget came from). Scanned: the books folder (current.json, any other book, and leftover *.json.tmp)
    and each folder in roots (the user's workflows/ and projects/: saved workflows, manifests, autosaves, the trash,
    *.json.tmp leftovers; and output/soundstage_projects/: collected copies, whose script/directors_book.json and
    project.json "book" / "workflow" hold the book: a collected folder is this project's when its name is the
    project's folder name or its project.json names this project, else another project's copy). ok True covers only
    these server-side files, never other open tabs, canvas undo, browser storage, ComfyUI's queue history
    (extra_pnginfo) or metadata inside rendered files. A file counts as the project's when it carries the same project id, or no id and the same
    project name (saved before ids existed); any file inside projects/<project name>/ counts too, whatever it carries
    (a library Rename moves a pre-id project's autosaves without restamping them, so they still name the old project),
    and so does the project's own saved workflow, workflows/<project name>.json, whatever id it carries (a two-tab save
    race can leave it holding another id than project.json); a server book with no _project is the open book and counts too. Only files whose text mentions an id are parsed;
    changed files are rewritten atomically.

    Files of another project that mention an id are listed in other_projects. A copy of THE SAME decision there (a note
    whose own id is one of the decision ids: a Duplicate or Save As copy, or the project's own workflow file when a
    two-tab race left it stamped with a different id) is listed in other_copies too and makes ok False: a copy remains.
    With everywhere=True those copies are removed as well, keyed by the decision's note id (never by ref: a chat turn
    id can be shared by an unrelated decision of another project, which is left alone). The decision ids are the ids
    given that are some chat note's own id, plus the ids of the notes this project's files matched by ref.

    Returns {ok, removed, files: [paths changed], still_mentions: [paths whose text still holds an id after cleaning,
    e.g. inside a string], skipped: [{path, why}]: files that mention an id but were not cleaned (too big, or not tied
    to any project), other_projects: [paths], other_copies: [paths still holding a copy of the decision], errors}.
    ok is False when skipped, still_mentions, other_copies or errors is non-empty: then not every copy is gone, and
    the caller must say so."""
    ids = {str(i) for i in (ids or []) if isinstance(i, str) and i.strip()}
    out = {"ok": True, "removed": 0, "files": [], "still_mentions": [], "skipped": [], "other_projects": [], "other_copies": [], "errors": []}
    if not ids:
        return out
    project = project if isinstance(project, dict) else {}
    pid = project.get("id") if isinstance(project.get("id"), str) and project.get("id") else None
    pname = project.get("name").strip() if isinstance(project.get("name"), str) and project.get("name").strip() else None
    if not pid and not pname:
        out["skipped"].append({"path": "*", "why": "no project given: only the open book (books/current.json) was cleaned"})
    try:
        from soundstage.project.collect import clean_name
        pfolder = clean_name(pname) if pname else None   # the folder name the project library gives that name
    except ImportError:
        pfolder = pname
    seen = set()
    bdir = os.path.realpath(books_dir())
    mine, others = [], []                                  # (path, data) of parsed files, by scope
    cscope: dict = {}                                      # collected folder -> is it this project's (from its project.json)

    def collected_scope(root, folder):
        """A collected copy (output/soundstage_projects/<folder>/): its script/directors_book.json names no project,
        so the whole folder is judged once: the forgetting project's folder name, or its project.json (the collected
        manifest, whose "workflow" carries extra.ss_project) naming this project. Else another project's copy."""
        if folder in cscope:
            return cscope[folder]
        sc = bool(pfolder) and folder == pfolder
        if not sc:
            try:
                with open(os.path.join(root, folder, "project.json"), encoding="utf-8") as f:
                    sc = bool(_in_scope(*_ident(json.load(f)), pid, pname))
            except (OSError, ValueError):
                sc = False
        cscope[folder] = sc
        return sc

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
                if pfolder and (_folder_of(root, p) == pfolder or _own_workflow(root, p, pfolder)):
                    scope = True                      # inside this project's own folder (e.g. autosaves kept through a Rename)
                cf = _collected_folder_of(root, p)
                if cf is not None and (pid or pname):
                    scope = collected_scope(root, cf)  # a collected copy: script/directors_book.json, project.json "book"
                if scope is None and in_books and os.path.basename(p).split(".")[0] == "current":
                    scope = True                      # the open book, saved before books carried their project
                if scope is None and not pid and not pname:
                    continue                          # reported once above
                if scope is None:
                    out["skipped"].append({"path": p, "why": "mentions the id but names no project, so it was not changed"})
                    continue
                (mine if scope else others).append((p, data))
            except (OSError, ValueError) as e:
                out["errors"].append(f"{p}: {e}")
    # The decision ids: given ids that are a chat note's own id anywhere, and the ids of this project's notes hit by ref.
    dec = set()
    for p, data in [*mine, *others]:
        for x in _chat_notes(data):
            if x.get("id") in ids:
                dec.add(x.get("id"))
    for p, data in mine:
        for x in _chat_notes(data):
            if x.get("ref") is not None and x.get("ref") in ids and isinstance(x.get("id"), str):
                dec.add(x["id"])

    def rewrite(p, data, keys):
        k = _strip(data, keys)
        if k:
            tmp = p + ".forget.tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False)
            os.replace(tmp, p)
            out["removed"] += k
            out["files"].append(p)
        return k

    for p, data in mine:
        try:
            rewrite(p, data, ids)
            if any(i in json.dumps(data, ensure_ascii=False) for i in ids | dec):
                out["still_mentions"].append(p)
        except (OSError, ValueError) as e:
            out["errors"].append(f"{p}: {e}")
    for p, data in others:
        out["other_projects"].append(p)
        try:
            if everywhere and dec:
                rewrite(p, data, dec)
            if any(x.get("id") in dec for x in _chat_notes(data)):
                out["other_copies"].append(p)
        except (OSError, ValueError) as e:
            out["errors"].append(f"{p}: {e}")
    out["ok"] = not (out["errors"] or out["skipped"] or out["still_mentions"] or out["other_copies"])
    if not out["ok"]:
        n = len(out["errors"]) + len(out["skipped"]) + len(out["still_mentions"]) + len(out["other_copies"])
        out["error"] = f"{n} stored cop{'y' if n == 1 else 'ies'} not cleaned: " + "; ".join(
            [*out["errors"], *[f"{s['path']} ({s['why']})" for s in out["skipped"]], *[f"{q} (still mentions it)" for q in out["still_mentions"]],
             *[f"{q} (another project's copy of this decision; forget with everywhere to remove it)" for q in out["other_copies"]]])[:600]
    return out

