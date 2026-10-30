"""Load, validate and query the cinematic knowledge base (soundstage/cine_kb/*.json).

Each KB file holds a JSON array of entries (or one entry). Entries are indexed by id and alias.
Run `python3 -m soundstage.cine.kb` from the pack root to validate every file.
"""
from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path

from .schema import KB_ENTRY_SCHEMA, validate

KB_DIR = Path(__file__).resolve().parent.parent / "cine_kb"

# Which entry types fill which picker on the Advisor node.
PICKER_TYPES = {
    "genre": ("genre", "subgenre"),
    "movement": ("movement", "national_cinema"),
    "technique": ("director_technique", "dp_technique"),
    "intent": ("emotion_recipe",),
    "coverage": ("coverage_pattern",),
}


class KnowledgeBase:
    def __init__(self, entries: list[dict], errors: list[str] | None = None):
        self.entries = entries
        self.errors = errors or []
        self.by_id = {e["id"]: e for e in entries}
        self._alias = {}
        for e in entries:
            for name in [e["id"], e["name"], *e.get("aliases", [])]:
                self._alias.setdefault(_norm(name), e["id"])

    def get(self, key: str | None) -> dict | None:
        """Look up by id, display name, alias or a picker label like 'Spaghetti Standoff  [technique.x]'."""
        if not key:
            return None
        m = re.search(r"\[([a-z0-9_.]+)\]\s*$", key)
        if m:
            key = m.group(1)
        if key in self.by_id:
            return self.by_id[key]
        eid = self._alias.get(_norm(key))
        return self.by_id.get(eid) if eid else None

    def of_types(self, *types: str) -> list[dict]:
        return [e for e in self.entries if e["type"] in types]

    def picker_labels(self, picker: str) -> list[str]:
        entries = sorted(self.of_types(*PICKER_TYPES[picker]), key=lambda e: e["name"].lower())
        return [label(e) for e in entries]

    def score(self, entry: dict, text: str, intents: list[str] = ()) -> float:
        """Keyword retrieval score of an entry against a scene description."""
        t = f" {_norm(text)} "
        s = 0.0
        for kw in entry.get("keywords", []):
            if f" {_norm(kw)} " in t:
                s += 1.0 + 0.25 * kw.count(" ")
        for alias in [entry["name"], *entry.get("aliases", [])]:
            if len(alias) > 3 and f" {_norm(alias)} " in t:
                s += 1.5
        s += 0.75 * len(set(intents) & set(entry.get("intent_tags", [])))
        return s

    def best(self, picker: str, text: str, intents: list[str] = (), min_score: float = 1.0) -> dict | None:
        """Best entry for a picker. The scene's own words must clear `min_score`; intents only break ties,
        so a mood alone never drags in an unrelated technique."""
        ranked = sorted(((self.score(e, text, intents), e["id"]) for e in self.of_types(*PICKER_TYPES[picker])
                         if self.score(e, text) >= min_score), reverse=True)
        return self.by_id[ranked[0][1]] if ranked else None


def label(entry: dict) -> str:
    return f"{entry['name']}  [{entry['id']}]"


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", s.lower()).strip()


def load_entries(kb_dir: Path = KB_DIR) -> tuple[list[dict], list[str]]:
    entries, errors = [], []
    seen: dict[str, str] = {}
    for path in sorted(kb_dir.glob("*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            errors.append(f"{path.name}: invalid JSON: {exc}")
            continue
        for i, entry in enumerate(data if isinstance(data, list) else [data]):
            where = f"{path.name}[{i}]"
            errs = validate(entry, KB_ENTRY_SCHEMA)
            errors += [f"{where} {entry.get('id', '?') if isinstance(entry, dict) else '?'}: {e}" for e in errs]
            if errs:
                continue
            if entry["id"] in seen:
                errors.append(f"{where}: duplicate id {entry['id']} (also in {seen[entry['id']]})")
                continue
            seen[entry["id"]] = where
            entries.append(entry)
    return entries, errors


@lru_cache(maxsize=1)
def get_kb() -> KnowledgeBase:
    entries, errors = load_entries()
    return KnowledgeBase(entries, errors)


if __name__ == "__main__":
    entries, errors = load_entries()
    counts: dict[str, int] = {}
    for e in entries:
        counts[e["type"]] = counts.get(e["type"], 0) + 1
    print(f"{len(entries)} valid entries: {counts}")
    for err in errors:
        print("ERROR", err)
    raise SystemExit(1 if errors else 0)
