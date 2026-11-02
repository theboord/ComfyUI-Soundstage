"""④ Frame "Lock to the stage depth" (soundstage/look/frame_lock.py VERSION 3): the depth pass's denoise is read the
same careful way as stage_denoise, and 0 / missing is off so every older frame reproduces."""
import pytest

from soundstage.look import frame_lock as FL


def test_version_records_the_depth_lock():
    assert FL.VERSION == 3


@pytest.mark.parametrize("v", [None, "", "x", 0, 0.0, -0.3, float("nan")])
def test_missing_or_zero_is_off(v):
    assert FL.depth_lock(v) == 0.0


def test_on_is_clamped_to_a_useful_range():
    assert FL.depth_lock(0.5) == 0.5
    assert FL.depth_lock("0.45") == 0.45
    assert FL.depth_lock(0.05) == FL.DEPTH_LOCK_MIN        # a trace of the pass would change nothing a check sees
    assert FL.depth_lock(1.0) == FL.DEPTH_LOCK_MAX         # a full repaint is a Krea frame, not Klein held to depth
    assert FL.DEPTH_LOCK_MIN < FL.DEPTH_LOCK < FL.DEPTH_LOCK_MAX


def test_stage_denoise_is_unchanged():
    assert FL.stage_denoise(None) == 1.0 and FL.stage_denoise(0.9) == 0.9 and FL.stage_denoise(0.1) == FL.MIN_DENOISE
