"""Stage-aware model router: one picker node per stage, every model (open weights and partner).

registry.json  every known model, tagged with the Soundstage stages it serves (built by build_registry.py)
registry.py    availability filtering + dropdown labels (pure Python, no ComfyUI imports)
adapters.py    per-model subgraph builders emitted through node expansion (pure Python)
"""
