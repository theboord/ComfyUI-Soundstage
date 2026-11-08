"""Find user-visible "clay" wording (Lifelike-only plan §3a, the grep test).

The clay look is retired: nothing the user sees may say "clay". Internal identifiers, saved data keys, pass names and
node slot names may still contain the word (the alias contract, plan §1.6), so this does not grep raw text. It reads:
  - JS/MJS/HTML under web/: the string literals (comments skipped). A literal is user text when it holds prose (a space)
    or is the capitalised word "Clay"; a bare lowercase key such as "clay" or "stage_clay_" is an identifier.
  - Python under soundstage/: the string literals that are not docstrings, by the same rule.
  - Markdown docs: every line (they are all read by people), except the history docs.
Allowed: the Ask synonym table and the alias tables (ALLOW below), each named by file and a marker on the line.

    python3 tools/clay_words.py            # list every hit in the lanes in scope
    python3 tools/clay_words.py --all      # also the pending lanes (web/cut, web/agent, docs/assistant, ...)
"""
from __future__ import annotations

import io
import re
import sys
import tokenize
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WORD = re.compile(r"clay", re.I)

# The lanes switched so far (Lifelike-only L2 words). Everything else is pending: the other agents' lanes (web/cut,
# soundstage/cut (the rung rename lands with web/cut in one commit, plan §1.4), web/agent, soundstage/agent, soundstage/memory, docs/assistant, skills) and the media/demo surfaces the plan gives to
# L20 (web/tryit, web/script, web/performance, web/passes, web/oneclick, web/presets, the root README).
SCOPE = ("web/pipeline/", "web/motion/", "web/coach/", "web/advisor/", "web/book/", "web/canvas/", "web/stage/",
         "web/ladder/", "web/soundstage.js", "web/ui/", "soundstage/", "docs/")
PENDING = ("web/cut/", "soundstage/cut/", "docs/cut.md", "web/agent/", "soundstage/agent/", "soundstage/memory/", "docs/assistant/", "skills/")
# History: kept as written (plan §3a: decisions.md and the CHANGELOG stay as history).
HISTORY = ("docs/decisions.md", "CHANGELOG.md")
# Not shipped to users: vendored code, local assets, test fixtures, research and the retired-look test references.
SKIP_DIRS = ("web/vendor/", "web/stage/people/rocketbox/", "node_modules/", "__pycache__/")

# file -> markers: a hit on a line holding one of these markers is an allowed alias / migration / synonym entry.
ALLOW = {
    "web/stage/stage.mjs": ("LEGACY_VIEW",),
    "web/canvas/canvas.mjs": ("LEGACY_STAGE_MODE",),
    "web/ladder/ladder.mjs": ("LEGACY_RUNG",),
    "web/soundstage.js": ("LEGACY_RENDERS",),
    "docs/agent.md": ("| alias",),
    "soundstage/project/collect.py": ("clay/",),
    "docs/projects.md": ("clay/ frames/",),   # the shot folder list: clay/ -> stage/ lands with the Cut rung rename   # the project folder clay/ -> stage/ lands with the Cut rung rename (plan §1.4)
}
# A line carrying one of these markers is allowed anywhere in scope:
#   clay-alias   an old saved name / key / synonym kept working (plan §1.6 alias contract, §3a synonym table)
#   clay-prompt  text sent to a model (a prompt premise): changes with the guide switch (L3, plan §1.3h), not here
#   clay-pending a line about a pending lane's UI (the Cut's Clay rung / badge, web/cut) or media re-shot in L20
MARKERS = ("clay-alias", "clay-prompt", "clay-pending")


def _js_strings(src: str):
    """Yield (line, text) for every string literal in JS source, skipping comments and regex literals (roughly)."""
    i, n, line = 0, len(src), 1
    prev = ""   # last significant char, to tell a regex literal from a division
    while i < n:
        c = src[i]
        if c == "\n":
            line += 1; i += 1; continue
        if c in " \t\r":
            i += 1; continue
        if src.startswith("//", i):
            j = src.find("\n", i); i = n if j < 0 else j; continue
        if src.startswith("/*", i):
            j = src.find("*/", i + 2); j = n if j < 0 else j + 2
            line += src.count("\n", i, j); i = j; continue
        if c in "'\"`":
            q, j, start, buf = c, i + 1, line, []
            depth = 0
            while j < n:
                d = src[j]
                if d == "\\":
                    buf.append(src[j:j + 2]); line += src.count("\n", j, j + 2); j += 2; continue
                if d == "\n":
                    line += 1
                    if q != "`":
                        break
                if q == "`" and src.startswith("${", j):
                    depth += 1; buf.append(" "); j += 2; continue
                if q == "`" and depth and d == "}":
                    depth -= 1; j += 1; continue
                if d == q and not depth:
                    break
                buf.append(d); j += 1
            yield start, "".join(buf)
            i = j + 1; prev = "a"; continue
        if c == "/" and prev in "(,=:[!&|?{};+-*%<>~^" + "":
            # a regex literal
            j = i + 1; cls = False
            while j < n and src[j] != "\n":
                if src[j] == "\\": j += 2; continue
                if src[j] == "[": cls = True
                elif src[j] == "]": cls = False
                elif src[j] == "/" and not cls: break
                j += 1
            i = j + 1; prev = "a"; continue
        prev = c if not (c.isalnum() or c in "_$)]") else "a"
        if c in ")]": prev = "a"
        i += 1


def _py_strings(src: str):
    """Yield (line, text) for every Python string literal that is not a docstring."""
    try:
        toks = list(tokenize.generate_tokens(io.StringIO(src).readline))
    except (tokenize.TokenError, SyntaxError, IndentationError):
        return
    sig = None   # previous significant token
    for t in toks:
        if t.type == tokenize.STRING:
            doc = sig is None or (sig.type in (tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT) or
                                  (sig.type == tokenize.OP and sig.string == ":"))
            if not doc:
                yield t.start[0], t.string
        if t.type == getattr(tokenize, "FSTRING_START", -1):
            # 3.12+: an f-string arrives in parts; gather its middle text
            pass
        if t.type == getattr(tokenize, "FSTRING_MIDDLE", -1) and WORD.search(t.string):
            yield t.start[0], t.string
        if t.type not in (tokenize.COMMENT, tokenize.NL):
            sig = t


def _is_user_text(s: str) -> bool:
    """Prose ("the clay pass") or the capitalised word ("Clay"); never a bare key ("clay", "stage_clay_")."""
    if not WORD.search(s):
        return False
    body = s.strip().strip("'\"fbrFBR")
    if re.search(r"\bClay\b|\bCLAY\b", body):
        return True
    return bool(re.search(r"\s", body.strip())) and bool(re.search(r"(?<![_./A-Za-z])clay(?![_A-Za-z0-9])", body, re.I) or re.search(r"\bclay\w*\b", body))


def scan(include_pending: bool = False):
    """Return a sorted list of (relpath, line, text) user-visible clay hits."""
    hits = []
    files = []
    for top in ("web", "soundstage", "docs", "skills"):
        p = ROOT / top
        if p.is_dir():
            files += [f for f in p.rglob("*") if f.is_file()]
    for top in ("README.md", "QUICKSTART.md"):
        if (ROOT / top).is_file():
            files.append(ROOT / top)
    for f in files:
        rel = f.relative_to(ROOT).as_posix()
        if any(s in rel + "/" for s in SKIP_DIRS) or rel in HISTORY:
            continue
        if not include_pending and (rel.startswith(PENDING) or not rel.startswith(SCOPE)):
            continue
        ext = f.suffix.lower()
        try:
            src = f.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        if not WORD.search(src):
            continue
        lines = src.splitlines()
        allow = ALLOW.get(rel, ())
        if ext in (".js", ".mjs", ".html"):
            found = [(ln, s) for ln, s in _js_strings(src) if _is_user_text(s)]
        elif ext == ".py":
            if not rel.startswith("soundstage/"):
                continue
            found = [(ln, s) for ln, s in _py_strings(src) if _is_user_text(s)]
        elif ext in (".md", ".json"):
            if ext == ".json" and not rel.startswith(("web/motion/", "web/ui/", "web/presets/")):
                continue
            found = [(i + 1, l) for i, l in enumerate(lines) if WORD.search(l)]
        else:
            continue
        for ln, s in found:
            if ext not in (".md", ".json"):   # the line of each hit inside a (multi-line) literal
                for m in WORD.finditer(s):
                    if re.match(r"[\w$.-]", s[m.start() - 1:m.start()] or " "):
                        continue   # inside an identifier or a CSS class (ss-clclay, stage_clay_, layer.clay)
                    at = ln + s[:m.start()].count("\n")
                    text = lines[at - 1] if 0 < at <= len(lines) else s
                    if text.lstrip().startswith(("/*", "//", "#")):
                        continue   # a CSS comment inside a style literal
                    if (allow and any(k in text for k in allow)) or any(k in text for k in MARKERS):
                        continue
                    hits.append((rel, at, text.strip()[:160]))
                continue
            text = lines[ln - 1] if 0 < ln <= len(lines) else s
            if (allow and any(k in text for k in allow)) or any(k in text for k in MARKERS):
                continue
            hits.append((rel, ln, s.strip()[:160]))
    hits = sorted(set(hits))
    return hits


if __name__ == "__main__":
    allp = "--all" in sys.argv
    hs = scan(allp)
    for rel, ln, s in hs:
        print(f"{rel}:{ln}: {s}")
    print(f"{len(hs)} user-visible clay hits", file=sys.stderr)
