"""Shot-grammar effects: one short sentence per choice, used to explain WHY a shot works.

These are the "grammar layer" of research/08 §2 (size, angle, lens band, move, framing). The KB
entries supply the style-specific why; these supply the mechanical why of each parameter.
"""
from __future__ import annotations

SIZE = {
    "EWS": "An extreme wide makes the landscape the subject and the people small inside it, which sets scale and stakes before anyone speaks.",
    "WS": "A wide shot gives the geography: who stands where and how much ground lies between them.",
    "FS": "A full shot keeps the whole body in play, so posture and stance carry the performance.",
    "COWBOY": "A cowboy frame (mid-thigh up) holds the face and the hands at hip level in one image, so readiness reads without a cut.",
    "MS": "A medium shot is the conversational distance: body language and face together, nothing forced.",
    "MCU": "A medium close-up is the dialogue workhorse: the face dominates but gesture still reads.",
    "CU": "A close-up hands the audience the character's inner state; viewers attribute more thought and feeling to a face this size.",
    "ECU": "An extreme close-up turns a detail into an event; at this size a blink or a glance is a plot point.",
    "INSERT": "An insert isolates the one piece of information the scene turns on, so the audience cannot miss it.",
}
FRAMING = {
    "fifty_fifty": "The 50/50 profile two-shot shows distance and equality: both players the same size, the empty space between them is the tension.",
    "ots": "Over-the-shoulder keeps the listener's presence in frame, so the exchange stays a relationship rather than two monologues.",
    "dirty_single": "Keeping part of the other character in the frame ties the single to the confrontation.",
    "two_shot": "The two-shot lets the relationship play in one frame, with reactions arriving without a cut.",
    "three_shot": "The three-shot fixes everyone's screen position, which the later singles rely on.",
    "pov": "The point-of-view shot makes the audience occupy the character's eyes and share what they do not know.",
    "establishing": "The establishing frame answers 'where are we' so every later close-up can be placed in space.",
    "master": "The master protects geography and gives the edit a place to return to.",
    "reaction": "The reaction shot tells the audience how to feel about what just happened.",
}
ANGLE = {
    "low": "The low camera lends stature or menace: we look up at the subject.",
    "high": "The high camera diminishes and surveils; the subject looks smaller and more exposed.",
    "overhead": "The overhead view turns people into a pattern, like a map seen by fate.",
    "worms_eye": "From the ground the subject becomes monumental, almost grotesque.",
    "dutch": "The canted horizon makes the world itself feel wrong.",
}
HEIGHT = {
    "hip": "Hip height puts the lens level with the holster, the eye-line of the gun hand.",
    "seated": "Seated eye height keeps us at the table with them, as an equal guest.",
    "ground": "Ground level makes the camera a witness from the dirt.",
    "high": "A raised camera puts the audience above the action, watching rather than taking part.",
}
MOVE = {
    "dolly_in": "The push-in reads as realization or mounting pressure; the slower it is, the more inevitable it feels.",
    "dolly_out": "The pull-back reveals context and leaves the subject smaller and more alone.",
    "track_follow": "Following from behind makes us move with the character without seeing what they feel.",
    "steadicam_follow": "The unbroken follow keeps time real, so the audience lives the moment rather than being told it.",
    "track_lead": "Leading the subject keeps their face on us while the world slides past behind them.",
    "arc_left": "Circling the subject heightens the moment; the background turning behind them says the world has fallen away.",
    "arc_right": "Circling the subject heightens the moment; the background turning behind them says the world has fallen away.",
    "crane_up": "Rising away from the subject lifts the audience out of the scene, a release or a verdict.",
    "crane_down": "Descending into the scene brings us down into the trouble.",
    "handheld": "Handheld breath makes the frame feel present and unrehearsed.",
    "pan_left": "The pan connects two things in one space, so their relation is felt, not cut.",
    "pan_right": "The pan connects two things in one space, so their relation is felt, not cut.",
    "tilt_up": "Tilting up sizes the subject up, feet to face, or reveals height and scale.",
    "tilt_down": "Tilting down finds what lies below, often the thing the character has not seen.",
    "truck_left": "The lateral move scans the scene like a tableau, keeping everyone at the same distance.",
    "truck_right": "The lateral move scans the scene like a tableau, keeping everyone at the same distance.",
    "zoom_in": "The zoom flattens as it tightens, a scrutinizing, observational push.",
    "snap_zoom": "The snap zoom is punctuation: a visual exclamation mark on the beat.",
    "whip_pan": "The whip pan joins two beats with raw energy and no cut.",
    "dolly_zoom": "The dolly zoom keeps the subject fixed while space warps behind them: the floor dropping out of a realization.",
    "rack_focus": "The rack focus moves attention without moving the frame, telling the audience where to look next.",
    "static": "The locked-off frame lets the performance carry the shot and makes any movement inside it count.",
}


def lens_band(mm: float) -> str:
    if mm < 18:
        return "The ultra-wide lens distorts space and faces, pushing the image toward the grotesque or subjective."
    if mm < 30:
        return f"The {mm:.0f}mm wide lens exaggerates depth, so the space around the subject becomes part of the drama."
    if mm < 60:
        return f"The {mm:.0f}mm normal lens keeps near-human perspective: honest and unforced."
    if mm < 110:
        return f"The {mm:.0f}mm short telephoto compresses gently and softens the background, pulling the face away from the world."
    return f"The {mm:.0f}mm long lens stacks the planes and isolates the subject, a watched, trapped feeling."
