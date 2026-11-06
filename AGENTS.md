# Working rules for AI agents in this repo (Claude, OpenAI/ChatGPT, anything else)

Read this first, every session. Soundstage is an open-source (MIT) film set inside ComfyUI. The maintainer is Mike Boord; his partner Jon drives day-to-day work on his own machine. Read `CONTRIBUTING.md` too.

## Usage limits (strict, set by Mike)
Usage is limited on purpose. Check it **before you start, and again after each phase of work** (a phase = one PR, one feature, one test cycle).
- **Claude: hard stop at 60%** of the weekly plan usage. At 60% finish the step you're on, commit, and stop.
- **OpenAI/ChatGPT agent: hard stop at 80%** of its plan usage.
- How to check: Claude Code `/usage` (or the plan-limits card in the app); ChatGPT/Codex usage page or `/status`.
- When you stop, leave a short note in `assistant/HANDOFF_NOTES.md` (what's done, what's half-done, the exact next step, the branch name), push the branch, and tell the human. Don't start a new task "just to use up" the remaining percent.
- Never turn on pay-as-you-go / extra usage or buy credits unless the human says so in that session.
- Cheapest model that can do the job: small edits, merges and doc work do not need the biggest model. Don't run broad exploratory sweeps; read only the files you need.
- Don't spawn parallel agents or cloud sessions unless the human asks. One thing at a time.

## Safety rules
- **No secrets in the repo, ever:** no API keys, tokens, passwords, SSH keys, pod addresses or ports, notification topics, or personal paths. Keys live in the OS keychain; scripts read them from environment variables.
- **No pods or paid GPU work without the human saying so in that session.** A pod costs money by the hour, and `stop` it when the work is done. Never print or log credential values.
- **Don't change account security settings** (RunPod, GitHub, Google, OpenAI, Anthropic) and don't enter credentials into any form. Tell the human what to do.
- Don't delete branches, force-push, or merge without the human's go-ahead. `main` takes changes through Pull Requests (see `CONTRIBUTING.md`).
- No private media. No real person's likeness or voice without consent. No model downloads without the maintainer approving the exact file.
- Report honestly: lead PRs with what is still wrong, say what you couldn't test (no GPU, no live ComfyUI), and never claim an action you didn't take.

## How the code is organised (short)
- `web/`: the App (browser UI, 3D stage, Ask assistant, Cut). `soundstage/`: the ComfyUI node pack (Python). `tools/`: installers, the MCP server, builders.
- Tests: `node --test tests/js/*.test.mjs` and `python3 -m pytest tests -q`. One JS test (`oneclick_sweep`, "stopped answering times out") is timing-flaky; if it's the only failure, run it alone.
- After changing UI labels or docs: `node tools/build_knowledge.mjs` (rebuilds Ask's knowledge pack and the agent skill's references; a test fails when they're stale).
- ✦ Ask's lessons live in `docs/assistant/SKILLS.md`; raw misses in `assistant/MISSES.md`. The agent skill for Claude Code is `skills/soundstage-agent/`.
- Add a dated, timed `CHANGELOG.md` entry in the existing "flaws first" style.

## What to work on (priority order, from Mike)
1. Tune ✦ Ask from real use (log misses, fix routing, add skills).
2. Local per-movie / per-person memory for Ask (stored on the user's machine only, visible and deletable).
3. Gaussian-splat sets (clip, still or 360° panorama into a walkable set).
4. Locations and props in Ask; the Cut as a fuller editor; Shot Projects (versioned takes).
5. Verify on a GPU: the new quality controls (shift, scheduler, low steps), the job-timer chime, pop-out panels, the bundled assistant model on fresh installs.
