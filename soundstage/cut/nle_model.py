"""D12 (Cut as an NLE) stub from S0a commit 1; owner: S0a. Python twin of web/cut/nle_model.mjs. No ComfyUI imports."""

from .nle_filler import normalize_filler_fields
from .nle_mix import normalize_mix_fields
from .nle_trims import normalize_trim_fields


def normalize_nle(project: dict) -> dict:
    return normalize_trim_fields(normalize_mix_fields(normalize_filler_fields(project)))


def track_extras(_t: dict) -> dict:
    return {}
