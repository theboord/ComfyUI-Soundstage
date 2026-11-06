# Task queue for Jon's agents (Claude and the OpenAI agent)

Mike reads and steers this from Jon's machine, so work happens on Jon's usage, not Mike's. Read `AGENTS.md` first (usage caps: Claude stops at 60%, OpenAI at 80%; no secrets; no pods or paid GPU work without a human OK).

**Lanes (see AGENTS.md):** the Claude agent works ONLY on tasks 2, 3, 4, 5; the OpenAI agent works ONLY on tasks 1, 6, 7, 8. Each takes the top unchecked task in its own lane, on its own branch prefix (`claude/…` or `gpt/…`), and writes to its own notes file. Never work on the other lane's tasks, and never edit its files.

**How to work:** take the top unchecked task in your lane, do only that, run the tests, open a PR (see `CONTRIBUTING.md`), tick the box, add a line to your own notes file, then stop and tell the human. Don't start the next task unless asked. Check your usage before each task.

- [ ] **1. [GPT] Verify on the GPU (no code needed first).** With Jon's local GPU: run a Draft with the new Advanced controls (shift, scheduler, 8 steps vs fewer), a LoRA stack of two rows, and a render with the job timer open. Judge the pictures by eye; listen to the done-chime (Activity panel → sound → Test) and tune its volume/length if needed. Record what worked and what looked bad in `assistant/HANDOFF_NOTES.md`. Done = a short written verdict per item, plus fixes for anything broken.
- [ ] **2. [CLAUDE] Tune ✦ Ask from real use.** Use Ask on a real script for 20 minutes. Log each miss in `assistant/MISSES.md`. Fix the top five causes (routing in `web/agent/ask.mjs`, the planner in `soundstage/agent/director.py`, tools in `web/agent/assistant.mjs`), add a skill for each in `docs/assistant/SKILLS.md`, run `node tools/build_knowledge.mjs`, tests green.
- [ ] **3. [CLAUDE] Locations and props in Ask.** Do for locations and props what characters already have: `gather_*`, `profile_*`, `update_*`, from scene headings and descriptions, citations, one Undo, confirm before any GPU regeneration. Tests with a fixture script.
- [ ] **4. [CLAUDE] Local memory for Ask (opt-in, on the user's machine only).** Per-movie memory (characters as the director shaped them, tone, decisions, what was rejected) and per-person memory (preferences, corrections like "when I say X I mean Y"). Stored in ComfyUI's user folder next to the project; never uploaded; a "What Ask has learned" page to read, edit, delete and switch off; Ask says when it used a memory; learn only from clear signals (a correction, a repeated choice, "remember that…"). Tests for storage, deletion and the off switch.
- [ ] **5. [CLAUDE] A "Teach it" button in the App.** On any Ask answer: 👎 → a small box (what you wanted) → appends to the local misses log; an export button writes `MISSES.md`-format text. Tests.
- [ ] **6. [GPT] Bundled assistant on a fresh install.** On Jon's OS, run the installer path for Ollama + the assistant model on a clean setup (or a clean folder), confirm Ask picks it up and falls back cleanly when it's absent. Fix the installer if it breaks; note OS-specific steps in the README Install section.
- [ ] **7. [GPT] Gaussian-splat sets.** Video → 3D gains a mode that turns a clip, a still or a 360° panorama into a walkable Gaussian-splat set the stage can block and reshoot on. Start with a design note and a minimal end-to-end path; ask the human before any model download.
- [ ] **8. [GPT] Smaller polish.** Tracks pop-out; make Paint Studio panels movable; `H`/`Tab` hide panels inside Drive without stealing driving keys; the time estimate runs short at high resolutions; remove leftover "Hollywood" wording from older docs and screenshots.

## Only Mike can do these (don't try)
- Republish the public demo and tutorial (his Claude artifacts), and set them public.
- Anything in his RunPod, GitHub, ElevenLabs or Magnific accounts.
- Posting, YouTube, and the README video link.
