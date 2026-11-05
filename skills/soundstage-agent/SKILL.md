---
name: soundstage-agent
description: Direct, build and troubleshoot Soundstage, the open-source film set inside ComfyUI (3D clay blocking, script breakdown, ScriptSync, Director's Book, stunts and practical effects, first frames, LTX video, a real-time cut). Use when the user mentions Soundstage, blocking a scene in 3D clay, a clay-to-render shot, the Director panel or ✦ Ask, ScriptSync, Draft/Final/Advanced quality, or wants a scene, stunt, camera move, character or edit built or fixed in the Soundstage App.
---

# Soundstage agent skill

Soundstage is a film set inside ComfyUI: you write or load a script, block each scene in 3D clay (set, cast, camera, stunts, practical effects), then open models paint the first frame and shoot the video with sound, following your blocking. You cut it on a real-time timeline. Everything runs locally by default on open-weight models. Be a collaborative director, DP and editor: ask one sharp creative question when intent is vague, then act.

## How to drive it
- **MCP (preferred):** Soundstage ships `tools/soundstage_mcp.py` (see `docs/mcp.md`). Tools: `soundstage_state` (look first), `soundstage_direct` (plain words in, a plan out), `soundstage_apply` (runs a plan in the open App), `soundstage_undo`, `soundstage_judge_take`, `soundstage_one_click`, plus typed `ss_<tool>` calls.
- **Propose, then apply.** Every change is a dry run that returns a `plan_id`. Show the user the plan, then apply. The App must be open in a browser for the change to run.
- **GPU work needs a yes.** Frames, drafts and finals need `confirm_gpu: true`. Say it uses the GPU, name the count, and ask first.
- **Everything is undoable** with `soundstage_undo` or "Undo this" in the Director panel.
- Without MCP, give the user exact clicks (see references) or use the in-App ✦ Ask.

## Rules that save time and money
1. **Look before you act:** `soundstage_state` first. Names must exist on the set.
2. **One shot, one card at a time.** Never use "…for every shot", "Generate all missing" or "Render missing shots" unless asked for exactly that.
3. **Never press ComfyUI's own Run button.** Soundstage has its own render buttons.
4. **Draft first, Final once approved.** Quality is Draft · Final · Advanced (no Hollywood preset; Advanced opens steps, shift, scheduler, sampler, CFG, seed, resolution, LoRA stack).
5. **Never claim an action you didn't take.** Report what changed, and say what you couldn't verify.
6. **Keep private material private.** Don't put a person's project, script or take names into public places.

## The seven steps (typical order)
① Script (import/breakdown) → ② Cast & Locations (a card per character, prop, place; ✨ Generate one at a time) → ③ Set (the 3D stage: objects, people, cars, horses, camera, lighting, stunts, practical effects, physics) → ④ Frame (first-frame candidates; Follow the clay, Paint Studio) → ⑤ Motion (LTX video; Adherence, Draft/Final/Advanced, LoRAs) → ⑥ Review (clay | draft | final wipe, blocking %, take checks, ScriptSync) → ⑦ Deliver (Cut, Layer Pack, exports to Avid/Premiere/Resolve/FCP). Projects save from the project pill (Save, autosave, Collect project).

## Common intents
- **"The clay isn't locking into the final":** ⑤ Adherence → Exact; Layout IC-LoRA near 1.0; clay guide blur low; ④ Follow the clay high; re-key the blocking; check "Follows your blocking %".
- **Describe or build a character from the script:** gather every scene, line and description with citations, profile it, then apply to the ② Cast card only with the user's OK; regenerate the sheet only with a GPU yes.
- **A stunt or effect (J-turn, crash, squib/gunshot, explosion, glass):** use the presets and practical-effects rigs in ③; time them on Tracks; one render at a time.
- **A camera move or coverage:** ③ Camera → New setup (Master, Wide, OTS, Single, Insert, POV), a lens card, a Presets camera move.
- **An edit (cut, dissolve, J/L, montage, Ripple, reshoot):** ⑦ the Cut; right-click a clip to go back to Frame/Motion/Paint/Recast.
- **Swap a character in real footage:** Recast (LTX union control by default; Openjutsu optional). **Record yourself:** Real performance / Capture motion. **Phone as the viewfinder:** ③ Phone camera, scan the QR.

## Read more (load only what you need)
- `references/lessons.md`: the lessons learned in testing (what people say, what they mean, what to do, what not to do). Generated from `docs/assistant/SKILLS.md`.
- `references/controls.md`: every labelled control by step with its help text. Generated from the App's source.
- Repo docs: `README.md`, `docs/TUTORIAL.md`, `docs/QUICKSTART.md`, `docs/mcp.md`, `docs/assistant.md`.

## Keeping this skill fresh
- Teach a new lesson by adding a skill to `docs/assistant/SKILLS.md` (raw misses go in `assistant/MISSES.md`).
- Regenerate with `node tools/build_knowledge.mjs`. It rewrites the in-App knowledge pack **and** `references/*`; a test fails if either is stale.
- Edit this `SKILL.md` by hand for rules and workflow; never hand-edit `references/`.

## Install it for Claude Code
```bash
cp -r skills/soundstage-agent ~/.claude/skills/
```
