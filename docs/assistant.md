# ✦ Ask, the co-pilot: plans, tools, the App's knowledge

✦ Ask (⌘/Ctrl+K, or the ✦ button) is meant to be the main way to make a film in Soundstage: you say what you want ("build the tall stranger from the script", "I want a gunshot wound on Reed in shot 3", "the claymation won't lock into the final render"). It answers like a director, DP or editor would, proposes a numbered plan of real App actions, runs it once you say **lock it in**, checks its own work, and gives you **one Undo** for the whole plan.

It works with whatever language model the Director uses (⚙ in the chat: the local model, Ollama, or an opt-in API model). With no model it still works: a built-in playbook routes the request and the same tools do the work.

## What it can do

| You say | What happens | Automated? |
|---|---|---|
| "build the tall stranger from the script" | `gather_character` finds who that is (REED: "a tall stranger with a shaved head…", Sc 1), shows every line, action and what others say about him, with citations. Plan: `profile_character` → `update_character` (the ② Cast card's description). | Yes. Regenerating the picture is a separate, confirmed step |
| "regenerate Reed's picture" | It asks first, then regenerates **that one card** (GPU). "Generate them all" is refused: one card at a time. | Yes, after your yes |
| "I want a gunshot wound on Reed in shot 3" | Recipe: `select_shot 3` → `select_object Reed` → `apply_preset squib_hit` (bullet hits walk up to him, then the body squib). It then checks the rig is on the set. | Yes; the cue time and blood-pack size are click-steps on the rig's card |
| "the claymation won't lock into the final render" | Troubleshoot: cause (Adherence below Exact, a loose engine, a strong first frame) and a fix plan: Adherence Exact, Layout IC-LoRA 1.0, a Draft first; plus click-steps (the engine). Each setting is read back after it's set. | Yes (settings); engine choice is a click-step |
| "how do I do a J-cut here" | The why (you hear the next shot first, so it pulls you forward) and click-steps in ⑥ Review › Cut. The Cut has no one-click split edit yet. | Click-steps |
| "re-block this chase, add a crash, then cover it in three shots" | One plan, clause by clause: the Director's planner re-blocks the chase, Crate crash + Impact shake, then three setups (wide, medium, close). | Yes |
| "where is Stage-2 start?" / "what does Breakable do?" | `search_docs`: the control, its tooltip and where it lives ("⑤ Motion › Advanced (LTX)"). | Yes (read only) |

Read tools run straight away (they change nothing): `search_docs`, `get_project_state`, `get_shot`, `list_cast`, `list_presets`, `get_settings`, `gather_character` / `_location` / `_prop`, and the script checks. Everything that changes the project only runs inside a plan you approved.

**Action tools:** `profile_*`, `update_*`, `regenerate_*` (characters, locations, props) · `stage_order` (any set change in words, through the Director's planner) · `select_shot`, `select_object`, `add_shot`, `apply_preset` (by name or id), `set_stunt`, `add_sfx_rig` (squib / gunshot wound, explosion, sparks; glass, fire, smoke through the planner), `camera` (lens, move, rig), `shot_length` · `set_quality` (Adherence, Layout IC-LoRA strength, Follow the clay, Draft / Final / Hollywood) · `assemble_cut`, `add_transition`. They reuse the App's own code: presets go through the Presets runner, set changes through the Director, cards through the ② Cast panel, quality through ⑤ Motion's own controls.

**Recipes (`plan_recipe`):** gunshot wound, explosion, breakaway glass, fire, sparks, crash, car stunts, chase, three-shot coverage, shot / reverse shot, J-cut, L-cut, dissolve / fade, assemble, Recast / Real performance, phone viewfinder, record yourself. **Troubleshooting (`troubleshoot`):** clay not followed in the final, lookalike characters, the camera clips the set, slow or queued renders, lip sync off, a LoRA with no effect, Ask slow on first load, ghost objects under the Strict depth lock, Video → 3D layouts that don't match.

## How a plan runs (the agent loop)

1. **Propose.** The model (or the playbook) answers with a numbered plan of tool calls. Nothing changes yet. A plan card shows the steps with **Lock it in** and **Discard**; typing "lock it in", "go", "yes" works too.
2. **Execute, observing.** With a model, each step it sees the approved plan and every result so far (OBSERVATION: what changed, the new shot or setting facts, or the error), and picks the next call. It may call read tools to look before it acts. On an error it gets **one** retry with different arguments; after that the step is reported as failed. It can never call an action tool that isn't in the approved plan. Hard limit: `MAX_STEPS` = 12. Without a model the plan runs in order.
3. **Self-check.** Every step that can read itself back is checked (the card shows the new description, Adherence reads Exact, the squib rig is on the set with its cue, shot 3 is active). If a check fails, the model gets one pass to fix it; otherwise Ask says so plainly.
4. **What I did.** A list of what changed, the checks (✓ / ✗), and one **Undo** that puts back the whole plan, newest step first.
5. **Stop.** The Stop button stops between steps. Then you choose **Undo what I did** or **Keep it**.

Tool calls are strict JSON, checked against each tool's schema (`web/agent/copilot.mjs` `TOOLS`, `validateCall`): unknown tools, missing or out-of-range arguments and bad enum values are rejected. If the model's reply isn't valid, Ask asks once more with the error; if that fails too, it falls back to the built-in playbook and says why.

## The knowledge pack

`tools/build_knowledge.mjs` extracts, from the source, without a model:

- every labelled control (button and row labels, tooltips, aria-labels, placeholders, menu options) with where it lives (step › panel) and its file;
- every preset (presets.json tabs), the SFX rigs and SFX preset cards, looks and lighting setups;
- quality and engine settings (ltx_presets.json Draft / Final / Hollywood, the Adherence levels and their knobs, the engines);
- the keyboard shortcuts (web/ui/shortcuts.mjs) and the 7 steps;
- README.md and docs/**/*.md cut into chunks at headings.

It writes `web/agent/knowledge/catalog.json` and `docs.json` (loaded only when Ask first searches). `search_docs` ranks them with BM25 and cites where. The system prompt carries only a short **Soundstage map** (`web/agent/knowledge.mjs` `SOUNDSTAGE_MAP`, under 1,500 tokens).

**After changing a label, tooltip, preset or doc, run `node tools/build_knowledge.mjs`**; the test `tests/js/copilot.test.mjs` fails while the pack is stale (`node tools/build_knowledge.mjs --check` says so too).

## Files

| Path | What it is |
|---|---|
| `web/agent/copilot.mjs` | Tools and schemas, `validateCall`, `parseStep`, the persona (`COPILOT_SYSTEM`), the router, `Copilot` (turn, propose, execute, Stop, Undo) |
| `web/agent/copilotui.mjs` | The chat side: plan card, live progress, What I did, Undo; `directorHands` (the Director as the co-pilot's set tools) |
| `web/agent/castops.mjs` | gather / profile / update / regenerate for characters, locations and props |
| `web/agent/playbook.mjs` | `TROUBLES` (symptom → cause → fix) and `RECIPES` (intent → steps) |
| `web/agent/knowledge.mjs` | BM25 search, `loadKnowledge()`, `SOUNDSTAGE_MAP` |
| `tools/build_knowledge.mjs` | The extractor (`--check` for staleness) |
| `tests/js/copilot.test.mjs` | Freshness, search, schemas, the five example questions (model and no model), cast tools, regenerate, plan → Undo, the agent loop, retries, Stop, self-check, re-ask |

## Limits

- Only tested with stubbed models and a fake App: how well a 4B local model follows this protocol is not measured. The Director's backends cap an answer at about 400 tokens, so a long plan from a small model can be cut off (then Ask re-asks once and falls back).
- J-cuts and L-cuts are click-steps: the Cut has no split-edit command.
- `stage_order` (re-block, add glass / fire) depends on the Director's planner understanding the words; a step it can't plan is reported as failed.
- Regenerate, renders and anything else on the GPU are never queued without your yes.
