"""README media v2 QC fixes in the prompt words (2026-11-02): each car is named as the real body style its model is,
with a blank plate; a stunt's tyre smoke is said as thick as the clay draws it, beat by beat; and two people keep
their own hat or hair and clothes for the whole shot, so the riders don't blend."""
import copy
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from soundstage.look import identity as I  # noqa: E402
from soundstage.look import stunts as ST  # noqa: E402
from soundstage.look.compile import compile_look  # noqa: E402

import test_stunts as T  # noqa: E402  (the Car Chase stunt scene)

BRANDS = re.compile(r"\b(ford|mustang|chevrolet|camaro|dodge|charger|bmw|audi|mercedes|porsche|ferrari|lexus|toyota|nissan|"
                    r"honda|opel|vauxhall|tesla|jaguar|aston|lamborghini|subaru|mazda|volkswagen|vw)\b", re.I)


def _smoky(car: dict, wet: bool = True) -> dict:
    """The stunt sim's baked tyre smoke, as the J-turn bakes it: none while reversing, a swell through the slide,
    full off all four tyres, then the rear tyres smoking as it drives off, still 0.35 at the end."""
    def amt(f):
        if f < 26:
            return 0.0
        if f < 50:
            return round((f - 26) / 24, 2)
        if f <= 80:
            return 1.0
        return round(1.0 - 0.65 * (f - 80) / 40, 2)
    for k in car["keys"]:
        f = int(k.get("frame", 0))
        k["fx"] = {"tire_smoke": amt(f), **({"wheels": "front" if f < 44 else "all" if f < 70 else "rear"} if amt(f) > 0 else {})}
    car["stunt_sim"] = {"surface": "wet" if wet else "dry", "entry_kmh": 40}
    return car


def _jturn(wet: bool = True):
    st, lk, car = T._stunt_scene("reverse_jturn")
    _smoky(car, wet)
    car["appearance"] = {"color": "#c23b2a"}
    return st, lk, car


def test_every_car_model_is_named_as_a_real_body_style_with_a_blank_plate():
    for kind in ("sports_car", "police_car", "hatchback", "car"):
        words = I.body_words({"actors": [{"id": "c", "kind": kind}]})
        assert words and "blank plain" in words and "license plate" in words and "no lettering" in words, kind
        assert not BRANDS.search(words), BRANDS.search(words).group(0)
    assert "fastback sports coupé" in I.body_words({"actors": [{"id": "c", "kind": "sports_car"}]})
    # car.glb (the library's "hatchback") is a three-box sedan: the words follow the model, not the label
    assert "four-door sedan" in I.body_words({"actors": [{"id": "c", "kind": "hatchback"}]})
    # the paint the scene sets goes in front of the body style
    assert I.body_words({"actors": [{"id": "c", "kind": "sports_car", "appearance": {"color": "#c23b2a"}}]}).startswith(
        "The sports car is a crimson modern two-door fastback")
    # people and props are not cars
    assert I.body_words({"actors": [{"id": "m", "kind": "man"}, {"id": "h", "kind": "horse"}]}) == ""


def test_the_jturn_prompts_carry_the_body_style_and_the_blank_plate():
    st, lk, _ = _jturn()
    r = compile_look(lk, st)
    for text in (r["still_prompt"], r["motion_prompt"]):
        assert "fastback sports coupé" in text and "blank plain white license plate" in text
        assert not BRANDS.search(text)
        assert not T.FORBIDDEN.search(text), T.FORBIDDEN.search(text).group(0)


def test_slip_smoke_is_said_as_strong_as_the_clay_shows_it_in_every_beat():
    # Road: Dry. On a wet road the tyres throw spray and mist, not dense smoke (Racing cinema review, 2026-11-02): below.
    st, lk, car = _jturn(wet=False)
    m = compile_look(lk, st)["motion_prompt"]
    i, j, k = m.index("races backwards"), m.index("slides around 180 degrees"), m.index("drives forward, nose first")
    assert i < j < k
    spin = m[j:k]
    assert "thick, billowing clouds of white tyre smoke" in spin, spin
    assert "all four tyres" in spin and "wrapping round the car" in spin
    assert re.search(r"from \d\.\d s", spin), "when the smoke starts"
    tail = m[k:]
    assert "bursting out of its own cloud" in tail and "wall of white smoke hanging over the road" in tail
    assert "still hanging in the air" in tail, "the clay's smoke is still there at the end"
    assert not T.FORBIDDEN.search(m)
    # A light slip (peak 0.3) is not oversold.
    car2 = copy.deepcopy(car)
    for kk in car2["keys"]:
        kk["fx"]["tire_smoke"] = round(min(0.3, kk["fx"]["tire_smoke"]), 2)
    st2 = copy.deepcopy(st)
    st2["actors"] = [car2 if a["id"] == car["id"] else a for a in st2["actors"]]
    m2 = compile_look(lk, st2)["motion_prompt"]
    assert "billowing" not in m2 and "a burst of white tyre smoke" in m2
    # No smoke keys at all (an old keyed stunt): nothing invented.
    car4 = copy.deepcopy(car)
    for kk in car4["keys"]:
        kk.pop("fx", None)
    car4.pop("stunt_sim", None)
    st4 = copy.deepcopy(st)
    st4["actors"] = [car4 if a["id"] == car["id"] else a for a in st4["actors"]]
    m4 = compile_look(lk, st4)["motion_prompt"]
    assert "billowing" not in m4 and "wall of white smoke" not in m4
    # Road: Wet: the same clay slip is spray and mist with a thin wisp of steam, never a wall of white smoke.
    stw, lkw, _ = _jturn(wet=True)
    mw = compile_look(lkw, stw)["motion_prompt"]
    assert "a fine sheet of spray and mist, with a thin wisp of steam at the contact patch, peels off all four tyres" in mw
    assert "pulling away through its own mist" in mw and "the mist stays thin and low" in mw
    assert not re.search(r"billowing|dense and white|wall of white smoke|white tyre smoke", mw)


def test_smoke_at_interpolates_the_baked_keys():
    car = {"keys": [{"frame": 0, "fx": {"tire_smoke": 0}}, {"frame": 10, "fx": {"tire_smoke": 1, "wheels": "rear"}},
                    {"frame": 20, "fx": {"tire_smoke": 0.5, "wheels": "rear"}}]}
    assert ST.smoke_at(car, 5) == 0.5 and ST.smoke_at(car, 15) == 0.75 and ST.smoke_at(car, 40) == 0.5
    assert ST._smoke_in(car, 8, 20) == (1.0, "rear")


WEST_LOOK = {"description": "Open desert at sunset. Exactly two people and two horses, all seen from behind: a man in a dark "
                            "canvas jacket, jeans and a cowboy hat and a woman in a white shirt and jeans run to a saddled "
                            "bay horse and a saddled grey horse, swing up into the saddles and gallop away."}


def _west():
    cam = [{"frame": 0, "position": [0, 1.2, -8], "target": [0, 1.0, 10], "focal_mm": 45},
           {"frame": 120, "position": [0, 1.2, 10], "target": [0, 1.0, 40], "focal_mm": 45}]
    walk = lambda x0, x1: [{"frame": 0, "position": [x0, 0, 0]}, {"frame": 48, "position": [x1, 0, 1.5]}]  # noqa: E731
    ride = lambda x: [{"frame": 0, "position": [x, 0, 1.5]}, {"frame": 120, "position": [x, 0, 40]}]  # noqa: E731
    return {"environment": {"set": "desert", "weather": "dust"}, "shot": {"frames": 121, "fps": 24}, "camera_keys": cam, "camera": cam[0],
            "actors": [
                {"id": "rider_a", "kind": "man", "height_m": 1.8, "mount_id": "horse_a", "pose": "ride", "mount_at": 48, "position": [-3.4, 0, 0], "keys": walk(-3.4, 0.6)},
                {"id": "rider_b", "kind": "woman", "height_m": 1.7, "mount_id": "horse_b", "pose": "ride", "mount_at": 54, "position": [-3.9, 0, -2], "keys": walk(-3.9, -1.0)},
                {"id": "horse_a", "kind": "horse", "height_m": 1.6, "position": [0.6, 0, 1.5], "keys": ride(0.6)},
                {"id": "horse_b", "kind": "horse", "height_m": 1.6, "position": [-1.0, 0, 1.5], "keys": ride(-1.0)}]}


def test_each_rider_keeps_their_own_hat_or_hair():
    sc = _west()
    words = I.people_identity(sc, WEST_LOOK)
    man, woman = words.split(";")[0], words.split(";")[1].split(".")[0]
    assert "the man wears a dark canvas jacket, jeans and a cowboy hat" in man.lower() and "short dark hair under the hat" in man
    assert "woman wears a white shirt and jeans" in woman and "bareheaded" in woman and "long dark hair" in woman
    assert "hat" not in woman.replace("bareheaded", ""), "the woman is never given the hat"
    assert "long" not in man, "the man is never given long hair"
    assert "Each rider keeps their own hat, hair and clothes from the first frame to the last" in words
    m = compile_look(WEST_LOOK, sc)["motion_prompt"]
    assert "his short dark hair under the hat" in m and "her long dark hair down her back" in m
    # The appearance picker's own hat (no description): still anchored.
    sc2 = _west()
    sc2["actors"][0]["appearance"] = {"hair": "hat", "hair_color": "#6b4a2a"}
    w2 = I.people_identity(sc2, {"description": ""})
    # (no description: each wears the lifelike avatar's own clothes, C22c; the hat is added to them)
    assert w2.startswith("The man wears a white polo shirt with thin brown stripes, khaki shorts and grey sneakers, "
                         "with a hat, his short hair under the hat; the woman wears a pink button-up shirt")
    assert "bareheaded" in w2
    # One person on their own has nobody to blend with, but still says what they wear (C22c).
    sc3 = _west()
    sc3["actors"] = [a for a in sc3["actors"] if a["id"] != "rider_b"]
    assert I.people_identity(sc3, WEST_LOOK) == ("The man wears a dark canvas jacket, jeans and a cowboy hat, fully clothed, "
                                                 "from the first frame to the last.")


def test_wardrobe_parsing_stops_at_the_next_person_and_the_verb():
    d = "a tall man in a grey suit and a fedora and a woman in a red dress walk into the bar"
    assert I._wardrobe(d, "man") == "a grey suit and a fedora"
    assert I._wardrobe(d, "woman") == "a red dress"
    assert I._wardrobe("two people on a beach", "man") == ""
