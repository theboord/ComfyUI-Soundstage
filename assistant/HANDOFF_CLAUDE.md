# Claude agent notes (newest first)
Add an entry when you stop: done, half-done, exact next step, branch. No secrets or personal paths.

## 2026-11-06: Ask loads on demand, on `claude/ask-load-on-demand`
- **Done:** no warm-up when the App opens; the model unloads after 10 idle minutes; a load note after 3 s.
- **Half-done:** never run with the real model. The cold-load time on the CPU tier against the 90 s limit is the thing to measure.
- **Next:** wait for a human to set the merge order. Whether the CPU tier should also unload before a render is an open question.

## 2026-11-06: task 2 done, PR open on `claude/ask-tuning`
- **Done:** 36 asks with `qwen3:30b-a3b` on an invented script; five causes fixed; `break_down_scene` added at Jon's request; skills added; knowledge pack rebuilt.
- **Half-done:** nothing. Still-open misses are at the top of `assistant/MISSES.md`.
- **Next:** stop for a human. The next task in this lane is 3 (locations and props); the cast-aware set planner miss ("a jane") fits there.
