"""The 3D stage by reference: a content-addressed store for big stage JSON, so queued prompts stay small.

Why: ComfyUI keeps every queued and finished prompt in memory and GET /queue and GET /history serialise them in
full. A busy scene (a crate crash's fracture bake, a car chase's baked paths) is 1-3 MB of JSON, and it rode in
every prompt up to three times (the 3D Stage node's input, the workflow copy in extra_pnginfo, the MP4 recipe).
With a few renders queued and a few pages polling, the event loop spent all its time encoding JSON (2026-11-01).

Now the stage JSON is stored once under ComfyUI's input/soundstage_stages/<sha256>.json and the prompt carries a
reference: '{"stage_ref":"<sha256>","bytes":N,"frames":F,"shot_id":"..."}'. The Soundstage nodes load it by hash.
Inline JSON (old saved workflows, small scenes) keeps working everywhere.

    put(text)            store a stage JSON string, returns its sha256 (dedupes)
    get(ref)             the stored text, or None
    ref_value(text)      put + the canonical reference string for a prompt input
    parse_ref(value)     the reference dict when `value` is one, else None
    resolve(value)       stage input (inline or by reference) -> dict; raises StageMissing for an unknown ref
    slim_prompt(body)    on-prompt handler: big inline stages (prompt, workflow copy, recipe) -> references
"""
from __future__ import annotations

import json
import os
import re
import tempfile
from hashlib import sha256

REF_KEY = "stage_ref"
SUBDIR = "soundstage_stages"
INLINE_MAX = 16 * 1024          # stage values up to this size stay inline (portable, and cheap to queue)
MAX_BYTES = 256 * 1024 * 1024   # refuse anything bigger than this (a stage is a few MB at most)
_HEX = re.compile(r"^[0-9a-f]{64}$")
STAGE_CLASS = "SoundstageStage"

_BASE: str | None = None        # tests point this at a temp dir


class StageMissing(ValueError):
    """A prompt points at a stored stage this server does not have."""


def store_dir(base: str | None = None) -> str:
    base = base or _BASE
    if base is None:
        import folder_paths
        base = folder_paths.get_input_directory()
    d = os.path.join(base, SUBDIR)
    os.makedirs(d, exist_ok=True)
    return d


def valid_ref(ref) -> bool:
    return isinstance(ref, str) and bool(_HEX.match(ref))


def put(text: str, base: str | None = None) -> str:
    """Store `text` (a stage JSON string) by its sha256; returns the hash. Writing the same text again is free."""
    if not isinstance(text, str):
        raise TypeError("stage must be a JSON string")
    raw = text.encode("utf-8")
    if len(raw) > MAX_BYTES:
        raise ValueError(f"stage is {len(raw)} bytes, over the {MAX_BYTES} byte limit")
    h = sha256(raw).hexdigest()
    d = store_dir(base)
    path = os.path.join(d, h + ".json")
    if not os.path.exists(path):
        fd, tmp = tempfile.mkstemp(dir=d, prefix=".tmp_", suffix=".json")
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(raw)
            os.replace(tmp, path)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
    return h


def get(ref: str, base: str | None = None) -> str | None:
    if not valid_ref(ref):
        return None
    try:
        with open(os.path.join(store_dir(base), ref + ".json"), encoding="utf-8") as f:
            return f.read()
    except OSError:
        return None


def _facts(data) -> dict:
    """Small facts a reference carries so readers (render timing, the queue summary) never load the stage."""
    scene = data.get("scene") if isinstance(data, dict) and isinstance(data.get("scene"), dict) else data
    out = {}
    if isinstance(scene, dict):
        try:
            f = int((scene.get("shot") or {}).get("frames") or 0)
            if f:
                out["frames"] = f
        except (TypeError, ValueError, AttributeError):
            pass
        sid = scene.get("shot_id") or scene.get("active_shot")
        if isinstance(sid, str) and sid:
            out["shot_id"] = sid[:80]
    return out


def ref_value(text: str, base: str | None = None, data=None) -> str:
    """Store `text` and return the canonical reference string the prompt carries instead of it. The same text always
    gives the same string (ComfyUI's cache keys on it)."""
    if data is None:
        data = json.loads(text)
    h = put(text, base)
    return json.dumps({REF_KEY: h, "bytes": len(text.encode("utf-8")), **_facts(data)}, separators=(",", ":"))


def parse_ref(value) -> dict | None:
    """The reference dict when `value` (a prompt input: str or dict) is a stage reference, else None. Cheap: a big
    inline stage is never parsed to find out."""
    if isinstance(value, dict):
        d = value
    elif isinstance(value, str) and len(value) < 4096 and REF_KEY in value:
        try:
            d = json.loads(value)
        except ValueError:
            return None
    else:
        return None
    return d if isinstance(d, dict) and valid_ref(d.get(REF_KEY)) and "scene" not in d else None


def resolve(value, base: str | None = None) -> dict:
    """The 3D Stage node's input as a dict: inline JSON (old workflows) or loaded by reference."""
    ref = parse_ref(value)
    if ref is None:
        if isinstance(value, str):
            return json.loads(value) if value.strip() else {}
        return value or {}
    text = get(ref[REF_KEY], base)
    if text is None:
        raise StageMissing(f"The 3D stage this render points at (stage {ref[REF_KEY][:12]}) is not on this server. "
                           "Open the stage and press Run again.")
    data = json.loads(text)
    # Flags a client may add next to the reference win over the stored copy.
    for k in ("look_start", "frame_lock"):
        if k in ref and isinstance(data, dict):
            data[k] = ref[k]
    return data


def try_resolve(value, base: str | None = None):
    """resolve(), or None when the value can't be read (unknown reference, bad JSON)."""
    try:
        return resolve(value, base)
    except (ValueError, TypeError):
        return None


# ---- on-prompt: keep every queued prompt light, whoever sent it ---------------------------------------------------

def _slim_str(v, base):
    """A big inline stage string -> its reference string; anything else unchanged."""
    if not isinstance(v, str) or len(v) <= INLINE_MAX or parse_ref(v) is not None:
        return v
    try:
        data = json.loads(v)
    except ValueError:
        return v
    if not isinstance(data, dict):
        return v
    return ref_value(v, base, data)


def _slim_workflow(wf, base) -> int:
    """SoundstageStage widget values in a UI workflow (top level and subgraph definitions) -> references."""
    n = 0
    if not isinstance(wf, dict):
        return 0
    groups = [wf.get("nodes") or []]
    for sg in ((wf.get("definitions") or {}).get("subgraphs") or []):
        if isinstance(sg, dict):
            groups.append(sg.get("nodes") or [])
    for nodes in groups:
        for node in nodes:
            if not isinstance(node, dict) or node.get("type") != STAGE_CLASS:
                continue
            wv = node.get("widgets_values")
            if isinstance(wv, list) and wv:
                new = _slim_str(wv[0], base)
                if new is not wv[0]:
                    wv[0] = new
                    n += 1
            named = node.get("widgets_values_named")   # newer frontends write the value a second time, by name
            if isinstance(named, dict) and "stage" in named:
                new = _slim_str(named["stage"], base)
                if new is not named["stage"]:
                    named["stage"] = new
                    n += 1
    return n


def slim_prompt(body: dict, base: str | None = None) -> dict:
    """ComfyUI on-prompt handler. Big inline stage JSON in the API prompt, in extra_pnginfo.workflow and in the
    Soundstage recipe tag becomes a reference to the store. Never raises; never touches a small or foreign prompt."""
    try:
        prompt = body.get("prompt") if isinstance(body, dict) else None
        if isinstance(prompt, dict):
            for node in prompt.values():
                if isinstance(node, dict) and node.get("class_type") == STAGE_CLASS:
                    inp = node.get("inputs")
                    if isinstance(inp, dict) and "stage" in inp:
                        inp["stage"] = _slim_str(inp["stage"], base)
        pnginfo = ((body.get("extra_data") or {}).get("extra_pnginfo")) if isinstance(body, dict) else None
        if isinstance(pnginfo, dict):
            _slim_workflow(pnginfo.get("workflow"), base)
            rec = pnginfo.get("soundstage")
            if isinstance(rec, dict) and isinstance(rec.get("scene"), dict):
                text = json.dumps(rec["scene"], separators=(",", ":"))
                if len(text) > INLINE_MAX:
                    rec["scene_ref"] = put(text, base)
                    del rec["scene"]
    except Exception:  # noqa: BLE001 - slimming must never stop a render
        import logging
        logging.exception("Soundstage: could not slim a prompt")
    return body
