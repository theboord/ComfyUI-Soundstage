# Handoff notes (newest first)

Agents: when you stop (usage cap, end of a phase, or the human leaves), add an entry here: what's done, what's half-done, the exact next step, the branch. Keep it free of secrets, addresses and personal paths.

## 2026-11-05, handoff from Mike's machine to Jon's
**State of `main`:** everything below is merged and tested (JS 1403 and Python 1709 green; one known-flaky timing test).
- Projects: named Save/Open/New, autosave, Collect project, a start screen with a launch splash, and the App always opens on the project screen first.
- ✦ Ask: a conversation with an agent loop, the Soundstage knowledge pack, character building from the script, troubleshooting and recipes, the skills notebook (`docs/assistant/SKILLS.md`) and a Claude agent skill (`skills/soundstage-agent/`).
- Bundled assistant model (Ollama + Qwen3-30B-A3B, placed by hardware) with the built-in ComfyUI Qwen3.5 4B as fallback.
- Quality is Draft · Final · Advanced (Hollywood removed) with shift and scheduler; LoRA stacks in ④ Frame and ⑤ Motion.
- Floating, foldable panels; Drive mode tucks them away; pop-out to a second screen (Properties, Presets, Ask).
- A live job timer (percent, steps, time left) and a soft done-chime.

**Not verified on a GPU:** picture quality on shifted or linear schedules and under 8 steps; the chime by ear; the pop-out in a real second window; the bundled assistant on a fresh install.

**Next step:** log real misses in `assistant/MISSES.md` while using the App, fix the cause, add a skill, rebuild the knowledge pack. Then the priorities in `AGENTS.md`.
