"""Takes that check themselves (Milestone 16).

After every draft or final the App runs fast CPU checks on the MP4 (detect.py): black frames, frozen or stuttering
stretches, jumps and pops between frames, heavy smear, face drift, and cars that drive backwards for the way they
face. blocking.py scores how well the take followed the stage (per-actor marks and the camera move). recipe.py
keeps the stage and shot settings inside the MP4, so the video carries its own recipe. timing.py turns measured
render times into the "about N min on your GPU" estimate, readiness.py says what a step still needs.

Everything here is pure Python + numpy (+ OpenCV when it is installed); routes.py is the only ComfyUI glue.
"""
