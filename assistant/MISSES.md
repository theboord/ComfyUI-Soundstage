# ✦ Ask misses log

Paste every time Ask got it wrong, rough is fine. Newest first. Later, turn the clear ones into skills in [docs/assistant/SKILLS.md](../docs/assistant/SKILLS.md) and rebuild (`node tools/build_knowledge.mjs`). This file is not indexed, so raw failures never leak into answers.

Format: **I said** … **It did** … **I wanted** … (optional: **Model / backend**, **Fixed?**)

## 2026-11-06 (qwen3:30b-a3b on the CPU, 16 GB card; an invented 10-scene test script, 36 asks in the App)
Cause 1, the model never saw the script's words, only headings:
- **I said:** "what happens in scene 6". **It did:** "waiting for a bus, holding a cup" (invented). **I wanted:** the locker, the cash, the drawing. **Fixed?** Yes.
- **I said:** "what does Jane want". **It did:** "trying to get Frank to help with the knife" (invented). **Fixed?** Yes: it now says the script doesn't state it, and cites what is there.
- **I said:** "which scenes is Frank in". **It did:** 4 and 8, then ran a locations check. **I wanted:** 3, 4 and 8. **Fixed?** Yes.
Cause 2, questions and small talk turned into set plans or unrelated checks:
- **I said:** "hi", then "thanks". **It did:** pitched scene 1 and offered a plan to bring in rain, twice. **Fixed?** Yes.
- **I said:** "how do I add rain". **It did:** offered the plan and named a "Plan Stage" tool. **I wanted:** the steps with Show me. **Fixed?** Yes.
- **I said:** "make it scarier". **It did:** a 'Horror Atmosphere' preset and a 'Blood Stain' prop, neither exists, plus a props check. **I wanted:** one good question. **Fixed?** Yes.
- **I said:** "the same for scene 4". **It did:** claimed duplicates above a card that found none; later a plan to add a booth. **Fixed?** Yes.
- **I said:** "generate a new image". **It did:** "I can't do generate_image yet". **Fixed?** Yes, it plans paint frames.
- **I said:** "note for scene 3: the sign should flicker". **It did:** a props check and "Apply this to SIGN's card?". **Fixed?** Yes.
Cause 3, invented settings and buttons:
- **I said:** "the clay isn't locking into the final", "my final looks nothing like my blocking", "it's rendering really slow". **It did:** "Follow the clay is at 0.85" all three times (no such reading), and a plan to change it to speed up a render. **Fixed?** Yes, the playbook answers.
- **I said:** "how do i save". **It did:** a Save button at the top right of the Set panel (there isn't one). **Fixed?** Yes: Project pill → Save, from the docs.
Cause 4, characters and the card:
- **I said:** "build the burly man". **It did:** said he isn't in the script. **Fixed?** Yes, "Everyone calls him FRANK" in the same paragraph now resolves him.
- **I said:** "who is Jane". **It did:** "which Jane do you mean?" for JANE and JANE DOE. **Fixed?** Yes, one person.
- **I said:** "change Frank's jacket to red on his card", then "yes". **It did:** "Apply?", then wrote nothing and said it had. **Fixed?** Yes: it shows the change, and the yes writes it (one Undo).
- **I said:** "are Jane and Jane Doe the same person". **It did:** "Apply this to JANE DOE's card?". **Fixed?** Yes.
- **I said:** yes to a profile with nothing in it. **It did:** "Wrote FRANK's card", before and after both empty. **Fixed?** Yes.
Cause 5, the answer's format and length:
- **I said:** "are the props in scene 5 real props". **It did:** raw JSON on screen, cut off at the 400-token budget. **Fixed?** Yes.
- **I said:** "so how is Frank described". **It did:** "Draft from script cues (no language model)" with the model running. **Fixed?** Yes: Frank's paragraph now reaches the model, and the label says why when it does draft.
- **I said:** "how do i do a match cut". **It did:** a JSON blob, then the Deliver recipe because of the word "cut". **Fixed?** Yes.
New, from Jon:
- **I said:** "it needs to break down each scene in detail with character, prop, location, emotion and tone, like a director's book". **It did:** nothing like that existed. **Fixed?** First version: break_down_scene.
- **Still open:**
  - "put Jane in the booth" plans "put a jane in the booth": the set planner doesn't know the script's cast.
  - The prop breakdown misses things a reader would list (the rag, the mop, the red gym bag). The director's reading adds them, the facts list doesn't.
  - "write me a new scene" asks questions and then can't write it: no tool for that yet.
  - "what's the capital of France" answers it. Harmless.
  - "the same for scene 4" needs a scene number; "do the same" alone still goes to the model.
  - A long script's breakdown takes one Next press per 2 scenes.

## 2026-11-04
- **I said:** "so how is Chase's character described in the movie". **It did:** "I couldn't turn that into a change on the set." **I wanted:** a description of Chase from the script. **Fixed?** Yes, lead-in words no longer make it an order; skill added.
- **I said:** "no, I just wanted you to describe to me what you think Chase is and how his character is from the script." **It did:** answered, but only after I asked twice. **Fixed?** Yes (same fix).
- **I said:** something like "make a new image". **It did:** nothing until I used exact words like "generate frames". **I wanted:** "image", "picture" and "regenerate" to mean frames. **Fixed?** Yes, in the planner.
- **Still open:** (add the next miss here)
