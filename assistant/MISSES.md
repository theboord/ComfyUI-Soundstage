# ✦ Ask misses log

Paste every time Ask got it wrong, rough is fine. Newest first. Later, turn the clear ones into skills in [docs/assistant/SKILLS.md](../docs/assistant/SKILLS.md) and rebuild (`node tools/build_knowledge.mjs`). This file is not indexed, so raw failures never leak into answers.

Format: **I said** … **It did** … **I wanted** … (optional: **Model / backend**, **Fixed?**)

## 2026-11-04
- **I said:** "so how is Chase's character described in the movie". **It did:** "I couldn't turn that into a change on the set." **I wanted:** a description of Chase from the script. **Fixed?** Yes, lead-in words no longer make it an order; skill added.
- **I said:** "no, I just wanted you to describe to me what you think Chase is and how his character is from the script." **It did:** answered, but only after I asked twice. **Fixed?** Yes (same fix).
- **I said:** something like "make a new image". **It did:** nothing until I used exact words like "generate frames". **I wanted:** "image", "picture" and "regenerate" to mean frames. **Fixed?** Yes, in the planner.
- **Still open:** (add the next miss here)
