# Working rules for AI agents in this repo (Claude, OpenAI/ChatGPT, anything else)

Read this first, every session. Soundstage is an open-source (MIT) film set inside ComfyUI. The maintainer is Mike Boord; his partner Jon drives day-to-day work on his own machine. Read `CONTRIBUTING.md` too.

## Usage limits (strict, set by Mike)
Usage is limited on purpose. Check it **before you start, and again after each phase of work** (a phase = one PR, one feature, one test cycle).
- **Claude: hard stop at 60%** of the weekly plan usage. At 60% finish the step you're on, commit, and stop.
- **OpenAI/ChatGPT agent: hard stop at 80%** of its plan usage.
- How to check: Claude Code `/usage` (or the plan-limits card in the app); ChatGPT/Codex usage page or `/status`.
- When you stop, leave a short note in YOUR OWN file (your private Claude handoff file for Claude, your private GPT handoff file for the OpenAI agent): what's done, what's half-done, the exact next step, the branch name, push the branch, and tell the human. Don't start a new task "just to use up" the remaining percent.
- Never turn on pay-as-you-go / extra usage or buy credits unless the human says so in that session.
- Cheapest model that can do the job: small edits, merges and doc work do not need the biggest model. Don't run broad exploratory sweeps; read only the files you need.
- Don't spawn parallel agents or cloud sessions unless the human asks. One thing at a time.

## Lanes: who owns what (so two agents never step on each other)
Two agents work at the same time, so each has its own tasks, its own files, its own branch prefix and its own notes file. Stay in your lane. If you need a change in the other lane's files, don't make it: write it in your notes file as "needs the other agent: <what>" and tell the human.

| | **Claude lane** (Ask) | **OpenAI-agent lane** (verify, install, new modules, polish) |
|---|---|---|
| **Tasks** | 2, 3, 4, 5 in the private task queue | 1, 6, 7, 8 in the private task queue |
| **Branch prefix** | `claude/<topic>` | `gpt/<topic>` |
| **Notes file** | your private Claude handoff file | your private GPT handoff file |
| **Owns these files** | `web/agent/**`, `soundstage/agent/**`, `docs/assistant/**`, the private misses log, `skills/**`, new `soundstage/memory/**` | `tools/**` (installers), `web/motion/**`, `web/ui/**`, `web/stage/**`, `web/pipeline/**` (polish only), `soundstage/ltx_settings.py`, new `soundstage/splat/**`, README Install section |
| **Never touches** | the OpenAI lane's files | the Claude lane's files |

**Shared files, handled carefully**
- `web/soundstage.js` is big and both lanes may need a hook in it: make the smallest possible edit (a one-line import or call into your own module), rebase just before opening your PR, and whoever opens a PR first goes first.
- `CHANGELOG.md`: add your entry at the top; if there's a merge conflict, keep both entries.
- `web/agent/knowledge_index.mjs` and `skills/soundstage-agent/references/*` are GENERATED: after any rebase or merge, never hand-merge them. Run `node tools/build_knowledge.mjs` and commit the result. Only the Claude lane edits the sources of that pack (`docs/assistant/**`, `web/agent/knowledge.mjs`); if the OpenAI lane changes a UI label or a doc, it still regenerates the pack as the last step.
- `README.md` / `docs/TUTORIAL.md`: the OpenAI lane edits Install, Quality and everything outside Ask; the Claude lane edits Ask sections only.
- **One open PR per agent at a time.** The human (Mike or Jon) merges, one PR at a time, running both test suites after each. Agents don't merge, push to `main`, delete branches or force-push.

## One machine, one GPU owner (both agents, both lanes)
Two agents can share Jon's machine, so they share its GPU, RAM and ComfyUI. Before any GPU job, model load or restart:
1. **Take the lock.** Create `~/soundstage_gpu.lock` containing your name (Claude or GPT), the job, the start time. If the file already exists, do NOT start: wait, or ask Jon.
2. **Release it** (delete the file) when the job ends, even if it failed.
3. **Only the GPT lane runs renders** during tasks 1 and 9. The Claude lane tests Ask with canned replies (its tests do this), so it never needs the GPU.
4. **Nobody restarts ComfyUI or Ollama** without the lock free and Jon's OK. A restart kills the other agent's job.
5. **Ask's model stays off during renders.** Let it unload before a render starts; never run Ask tests while a render is running.
6. **Separate ports.** A test copy runs on a different port from Jon's main install.

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
- ✦ Ask's lessons live in `docs/assistant/SKILLS.md`; raw misses in the private misses log. The agent skill for Claude Code is `skills/soundstage-agent/`.
- Add a dated, timed `CHANGELOG.md` entry in the existing "flaws first" style.

## What to work on (priority order, from Mike)
1. Tune ✦ Ask from real use (log misses, fix routing, add skills).
2. Local per-movie / per-person memory for Ask (stored on the user's machine only, visible and deletable).
3. Gaussian-splat sets (clip, still or 360° panorama into a walkable set).
4. Locations and props in Ask; the Cut as a fuller editor; Shot Projects (versioned takes).
5. Verify on a GPU: the new quality controls (shift, scheduler, low steps), the job-timer chime, pop-out panels, the bundled assistant model on fresh installs.
