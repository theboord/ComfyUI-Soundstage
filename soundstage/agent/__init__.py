"""Soundstage Scene agent: describe a scene in words, the 3D stage builds it; then edit it by chat.

Pure Python (no torch, no ComfyUI imports) so it runs in tests and on the server alike.
- catalog.py   what the stage can show: sets (floor bounds, anchors), library objects, times, lights
- prompts.py   the two small system prompts for Qwen3.5-4B (build plan, edit ops)
- plan.py      scene text -> plan (rules), and LLM plan parsing/merging
- build.py     plan -> complete stage scene JSON (placement, lights, coverage via the Director's Advisor)
- validate.py  schema check + repair (metres, on the floor, inside the set, no overlaps)
- ops.py       chat command -> symbolic ops (rules or LLM) -> concrete undoable ops, apply_ops()
- routes.py    HTTP routes; register() mounts them
"""
