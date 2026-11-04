# ✦ Ask, the co-pilot: plans that really run

✦ Ask (⌘/Ctrl+K) already knows Soundstage (the knowledge pack, `search_docs`), troubleshoots (`troubleshoot`), suggests recipes (`plan_recipe`) and builds characters from the script (`web/agent/charbuild.mjs`). The co-pilot (`web/agent/copilot.mjs`) adds the part that **acts**. It turns a request, a fix or a recipe into a numbered plan of real App actions. You **lock it in**. Then it runs the plan step by step, watches each result, checks its own work, and gives you **one Undo** for the whole plan.

It uses whatever language model the Director has (⚙ in the chat). With no model, the same plans come from the playbook and run in order.

## What runs, and what stays click-steps

| You say | The plan | |
|---|---|---|
| "the claymation won't lock into the final render" | Adherence Exact → Layout IC-LoRA 1.0 → Follow the clay 0.95, each read back after it's set | automated |
| "I want a gunshot wound on Cole in shot 3" | select shot 3 → select Cole → the Squib hit rig; the check confirms the rig and its cue | automated (move the rig or change the cue on its card) |
| "re-block this chase, add a crash, then cover it in three shots" | the Director's planner re-blocks the chase → Crate crash → Impact shake → wide, medium, close setups | automated |
| explosion, sparks, fire, glass, J-turn / donut / handbrake, a fall, a camera move, dialogue coverage, montage, ripple, a dissolve, a slow render (Draft), a camera inside the set | the matching preset, rig or setting | automated |
| "how do I do a J-cut here", match cut, Recast, phone viewfinder, record yourself, lip sync, LoRA fixes | main's recipe or playbook steps | click-steps |
| "build the burly man from the script" | main's character builder (gather, profile, the card, regenerate after a yes) | automated |

**Do it for me** on a Troubleshooting or recipe card now opens that plan. Only when nothing in it is runnable does it fall back to handing the Director a sentence.

## Tools

- **Read** (run at once, change nothing): `search_docs`, `get_project_state`, `get_shot` (camera, lens, length, objects, SFX rigs and their cues, presets used), `list_cast`, `list_presets`, `get_settings`, `gather_character` / `gather_location` / `gather_prop`, and the script checks.
- **Act** (only inside a plan you approved):
  - Cast: `profile_*`, `update_*`, `regenerate_*` for characters, locations and props (one card; regenerate needs the approved plan or a yes).
  - Stage: `stage_order` (anything in words, through the Director's planner), `select_shot`, `select_object`, `add_shot`, `apply_preset` (by name or id), `set_stunt`, `add_sfx_rig` (squib, explosion, sparks, glass, fire, smoke), `camera` (lens, move, rig), `shot_length`.
  - Quality: `set_quality` (Adherence, Layout IC-LoRA strength, Follow the clay, Draft / Final / Hollywood).
  - Edit: `assemble_cut`, `add_transition`. J/L cuts have no command in the Cut yet, so they are click-steps.
- **Plan**: `troubleshoot` and `plan_recipe` (main's), returning their runnable steps.

Every call is strict JSON, checked against the tool's schema (`validateCall`). Unknown tools, missing or out-of-range arguments and bad enum values are rejected. If the model's reply isn't valid, Ask asks once more, telling it what was wrong; if that fails too, the playbook takes over and Ask says why.

## How a plan runs

1. **Propose.** A plan card with numbered steps, **Lock it in** and **Discard**. Nothing has changed yet.
2. **Run, observing.** With a model, each step it sees the approved plan and every result so far (OBSERVATION: what changed, the shot's new facts, or the error) and picks the next call. It can look first with a read tool. A failed step gets **one** retry with other arguments; after that it's reported as failed and the plan goes on. It can't call an action outside the approved plan. At most `MAX_STEPS` (12) steps. Without a model, the plan runs in order.
3. **Self-check.** Each step that can read itself back is checked: the card shows the description, Adherence reads Exact, the squib rig is on the set with its cue, shot 3 is active. If a check fails, the model gets one pass to fix it; otherwise Ask says so.
4. **What I did.** What changed, the checks (✓ / ✗), and one **Undo** for the whole plan, newest step first.
5. **Stop.** Stops between steps. Then choose **Undo what I did** or **Keep it**.

## Files

| Path | What it is |
|---|---|
| `web/agent/copilot.mjs` | Tool schemas, `validateCall`, `parseStep`, the persona, `planFor` (main's playbook / recipes → steps, clause by clause), `Copilot` (turn, propose, execute, Stop, Undo) |
| `web/agent/copilotui.mjs` | The plan card, live progress, What I did, Undo; `doIt` for "Do it for me"; `directorHands` (the Director as the co-pilot's set tools) |
| `web/agent/thingops.mjs` | Locations and props: gather, profile, update, regenerate (the character pattern) |
| `tests/js/copilot.test.mjs` | Schemas, the example questions, plan → Undo, the observe loop, retries, Stop, self-check, re-ask, MAX_STEPS, locations / props, characters in a plan |

## Limits

- Tested only with stubbed models and a fake App. How well the local model or Qwen3-30B-A3B follows the plan protocol is unmeasured. The backends cap an answer at about 400 tokens, so a long plan can be cut off; then Ask re-asks once and falls back.
- `stage_order` and `add_shot` depend on the Director's planner understanding the words; a step it can't plan is reported as failed.
- Anything that uses the GPU (regenerate, renders) waits for your yes.
