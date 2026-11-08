"""The round-9 CHANGELOG entry's known limits say what actually fails (text checks only, no GPU, invented data only).

1 the set-piece limit names the shapes the review found cut (gable, dome or arch, stepped block, shallower gable with a
  wider box), not the T-sign that is not cut, and says the neck test was not added
2 the wardrobe limit lists the echoes still kept as clothing and round 6's example-plus-a-garment read dropped as ''
Run:  python -m pytest tests/test_v2s_changelog_r9.py -q
"""
import os

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HEAD = "**Video → 3D street-dance fixes, review round 9 (final round)"


def round9_limits(text):
    """The 'Known limits' part of the round-9 entry's 'Still wrong' line."""
    entry = text[text.index(HEAD):]
    still = entry[entry.index("**Still wrong (read first):**"):]
    still = still[:still.index("\n- **Fixed**")]
    return still[still.index("**Known limits"):]


@pytest.fixture(scope="module")
def limits():
    with open(os.path.join(ROOT, "CHANGELOG.md"), encoding="utf-8") as f:
        return round9_limits(f.read())


def test_the_set_piece_limit_names_the_shapes_that_fail(limits):
    assert "(a T-shaped sign on a post, a lamp head on a pole)" not in limits   # the review's T-sign is not cut
    for words in ["gable roofline peaked over her head", "68,133-92,142", "92,142", "10,577", "dome or arch",
                  "18,862 vs 9,571", "40,880 vs 11,143", "stepped block", "36,948", "10,786",
                  "8 m / 0.5 m, 4 m / 0.25 m and 3 m / 0.15 m", "shallower gable", "80 px wider",
                  "neck test", "was not added", "same as on a5a7a37"]:
        assert words in limits, words


def test_the_wardrobe_limit_lists_the_echoes_still_kept_and_the_dropped_read(limits):
    for words in ["she's wearing an orange cable-knit sweater and brown corduroys", "'she s'", "`_WEARS`",
                  "commonest", "the woman wears", "woman wearing", "a pair of brown corduroy trousers",
                  "brown corduroys, orange cable-knit sweater, red beanie", "reads as ''", "Round 6's behaviour"]:
        assert words in limits, words
