"""Read a free-text scene description: intents, location, time, weather and the cast.

Deliberately simple keyword rules: the rules backend must work offline and deterministically.
The optional LLM backend gets the same parse as context and can override it.
"""
from __future__ import annotations

import re

INTENT_WORDS = {
    "tension": ["face off", "faces off", "standoff", "stand-off", "duel", "showdown", "confront", "confrontation",
                "interrogat", "neither will", "won't back down", "stare down", "staredown", "the draw"],
    "suspense": ["bomb", "ticking", "timer", "doesn't know", "does not know", "unaware", "hidden", "hiding"],
    "menace": ["gunfighter", "gunslinger", "gunman", "killer", "threat", "villain", "loaded", "armed"],
    "intimacy": ["first date", "date", "whisper", "confess", "confession", "hold hands", "lean in", "close together"],
    "romance": ["first date", "date", "kiss", "flirt", "in love", "lovers", "romantic", "crush", "sweetheart"],
    "isolation": ["alone", "lonely", "loneliness", "by himself", "by herself", "empty", "solitary", "isolated",
                  "abandoned", "nobody", "no one"],
    "dread": ["creak", "something upstairs", "dark hallway", "shadow", "ominous", "haunted", "ghost", "uneasy"],
    "melancholy": ["rain-soaked", "rain soaked", "regret", "memory", "late at night", "smoke", "bourbon",
                   "whiskey"],
    "grief": ["funeral", "grave", "grief", "mourn", "died", "death of", "loss"],
    "comedy": ["sitcom", "joke", "comedy", "comedic", "funny", "awkward", "pratfall", "punchline", "slapstick",
               "deadpan", "hilarious", "spills", "trips over", "slips"],
    "awe": ["vast", "enormous", "massive", "spaceship", "cathedral", "mountain", "sky", "giant"],
    "chaos": ["explosion", "riot", "panic", "chase", "crash", "battle", "fight breaks out"],
    "power_imbalance": ["boss", "interrogation", "kneel", "begs", "towering", "threatens", "owes"],
    "paranoia": ["followed", "watched", "surveillance", "spy", "wiretap", "conspiracy"],
    "triumph": ["wins", "victory", "triumph", "crowd cheers", "finish line"],
    "joy": ["laugh", "celebrat", "party", "dance"],
    "realism": ["documentary", "interview", "real streets", "handheld"],
    "energy": ["action", "sprint", "gallop", "chase", "escape", "getaway", "flee", "ride off", "rides off",
               "ride away", "races", "racing", "on the run", "pursuit", "vault", "leap", "jumps"],
}

INT_WORDS = ["office", "diner", "room", "kitchen", "bar", "apartment", "house", "hallway", "corridor", "car",
             "booth", "restaurant", "cafe", "café", "bedroom", "living room", "church", "warehouse", "interior",
             "inside", "station", "precinct", "motel", "studio", "set"]
EXT_WORDS = ["street", "desert", "field", "town", "road", "beach", "forest", "plain", "alley", "rooftop", "noon",
             "outside", "exterior", "square", "cemetery", "graveyard", "main street", "park", "mountain"]
TIMES = ["dawn", "sunrise", "morning", "noon", "midday", "afternoon", "golden hour", "magic hour", "dusk",
         "sunset", "evening", "night", "midnight", "late at night", "blue hour"]
WEATHER = {"rain": "rain streaking the windows" , "storm": "a storm outside", "snow": "falling snow",
           "fog": "fog", "mist": "mist", "dust": "dust in the air", "wind": "wind"}

SEATED_WORDS = ["diner", "booth", "table", "dinner", "restaurant", "cafe", "café", "seated", "sitting", "desk",
                "date", "bar stool", "couch", "sofa"]

CAST_NOUNS = ["gunfighter", "gunslinger", "gunman", "bandit", "duelist", "rider", "horseman", "runner",
              "fugitive", "getaway driver", "date", "wife", "husband", "boyfriend", "girlfriend", "guest", "cowboy", "sheriff", "outlaw", "rancher", "detective", "cop", "officer",
              "agent", "soldier", "woman", "man", "girl", "boy", "kid", "child", "mother", "father", "nurse", "doctor",
              "teacher", "student", "waitress", "waiter", "bartender", "priest", "stranger", "friend", "lover",
              "couple", "boss", "thief", "killer", "pilot", "astronaut", "samurai", "knight", "king", "queen",
              "witness", "suspect", "lawyer", "judge", "reporter", "musician", "dancer", "driver", "brother",
              "sister", "rival", "partner", "roommate", "neighbor", "ghost", "robot", "old man", "old woman",
              "young man", "young woman"]
NUMBERS = {"two": 2, "three": 3, "four": 4, "both": 2, "a pair of": 2, "pair of": 2}
PLURALS = {"men": "man", "women": "woman", "kids": "kid", "children": "child", "people": "person",
           "thieves": "thief", "gunmen": "gunman", "riders": "rider", "soldiers": "soldier", "sisters": "sister", "brothers": "brother"}


def _has(text: str, word: str) -> bool:
    return re.search(r"(?<![a-z])" + re.escape(word), text) is not None


# Atmosphere words colour a scene but rarely name its dramatic job, so they rank lower.
INTENT_WEIGHT = {"menace": 0.6, "melancholy": 0.4, "realism": 0.5, "joy": 0.6}


def detect_intents(text: str) -> list[str]:
    t = text.lower()
    scored = []
    for intent, words in INTENT_WORDS.items():
        hits = sum(1 for w in words if _has(t, w)) * INTENT_WEIGHT.get(intent, 1.0)
        if hits:
            scored.append((hits, intent))
    scored.sort(key=lambda x: (-x[0], list(INTENT_WORDS).index(x[1])))
    return [i for _, i in scored]


def parse_location(text: str) -> dict:
    t = text.lower()
    int_hits = sum(_has(t, w) for w in INT_WORDS)
    ext_hits = sum(_has(t, w) for w in EXT_WORDS)
    time = next((w for w in sorted(TIMES, key=len, reverse=True) if _has(t, w)), "")
    weather = [desc for w, desc in WEATHER.items() if _has(t, w)]
    place = ""
    for m in re.finditer(r"\b(?:in|at|on|inside|across|outside)\s+(?:a|an|the|his|her|their)\s+([a-z][a-z\- ']{2,60}?)"
                         r"(?=[,.;!?]| at | as | while | when | with | and |$)", t):
        cand = m.group(1).strip()
        if cand not in TIMES and not any(cand == x for x in ("moment", "same time")):
            place = cand
            break
    return {
        "int_ext": "INT" if int_hits > ext_hits else "EXT" if ext_hits else "INT",
        "place": place,
        "time_of_day": time,
        "weather": weather,
        "seated": any(_has(t, w) for w in SEATED_WORDS),
    }


def parse_characters_field(text: str) -> list[dict]:
    """'Cole: weathered gunfighter in a duster; Hatch: rancher in black' (one per line or ';')."""
    cast = []
    for part in re.split(r"[;\n]+", text or ""):
        part = part.strip()
        if not part:
            continue
        name, _, desc = part.partition(":")
        name, desc = name.strip(), desc.strip()
        cast.append({"name": name if desc else "", "description": f"{name}, {desc}" if desc else name})
    return cast


def guess_cast(text: str) -> list[dict]:
    """Best-effort cast from prose: 'two gunfighters' -> two gunfighters, 'a detective alone' -> one."""
    t = text.lower()
    for num_word, n in NUMBERS.items():
        for pat in (rf"\b{num_word}\s+([a-z]+)", rf"\b{num_word}\s+[a-z\-]+\s+([a-z]+)"):
            m = re.search(pat, t)
            noun = PLURALS.get(m.group(1), m.group(1).rstrip("s")) if m else ""
            if noun in CAST_NOUNS or noun == "person":
                break
        else:
            continue
        if True:
                if n == 2:
                    return [{"name": "", "description": f"a {noun}"}, {"name": "", "description": f"a rival {noun}"
                             if noun in ("gunfighter", "gunslinger", "gunman", "outlaw", "bandit", "duelist", "samurai", "knight") else f"another {noun}"}]
                return [{"name": "", "description": f"{['a', 'a second', 'a third', 'a fourth'][i]} {noun}"}
                        for i in range(n)]
    if any(_has(t, w) for w in ("first date", "a date", "on a date", "couple", "lovers")):
        return [{"name": "", "description": "a young man"}, {"name": "", "description": "a young woman"}]
    found = []
    for noun in sorted(CAST_NOUNS, key=len, reverse=True):
        for m in re.finditer(rf"\b(a|an|the|his|her)\s+(?:[a-z\-]+\s+)?{noun}\b", t):
            if not any(m.start() < f[1] and f[0] < m.end() for f in found):
                found.append((m.start(), m.end(), noun))
    found.sort()
    cast = [{"name": "", "description": f"the {noun}"} for *_, noun in found[:3]]
    if not cast:
        cast = [{"name": "", "description": "the protagonist"}]
    if any(_has(t, w) for w in ("alone", "by himself", "by herself", "solitary")):
        cast = cast[:1]
    return cast
