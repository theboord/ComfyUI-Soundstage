"""Voice change of a long take in pieces cut at its pauses, put back at the same samples (pure numpy, testable).

Chatterbox VC turns the performance into 25 Hz speech tokens and re-draws them in the target voice, so a piece
comes back as long as it went in. A whole 55 s pass in one go drifted towards the performer's own timbre and,
on a man playing a woman, left 0.6 s of stray voice in the pauses; in pieces of at most 20 s cut in the middle of
the longest pauses, the target voice held (bench: share/Recording_Session_Mon/voice/_work/summary_table.md). A clip of 20 s or less is
converted whole.

Pause guard: a piece that starts on seconds of room tone can come back with a mumble in it (measured: 2.7 s at
-35 dBFS in a 10 s pause over -61 dBFS room). The performer was silent there, so in the take's pauses the converted
voice is never allowed above the performance's own level + headroom_db. Breaths are louder than the pause threshold,
so they are not pauses and stay as converted.
"""
import numpy as np

CHUNK_S = 20.0


def frame_db(x, sr, win_s=0.02, hop_s=0.01):
    """Frame levels in dB (20 ms windows, 10 ms hop)."""
    x = np.asarray(x, np.float64)
    win, hop = max(1, int(win_s * sr)), max(1, int(hop_s * sr))
    if len(x) < win:
        return np.array([10 * np.log10(np.mean(x ** 2) + 1e-12)]) if len(x) else np.array([-120.0])
    n = 1 + (len(x) - win) // hop
    idx = np.arange(win)[None, :] + hop * np.arange(n)[:, None]
    return 10 * np.log10(np.mean(x[idx] ** 2, axis=1) + 1e-12)


def silence_threshold(db, below_db=40.0):
    """A frame is a pause under: 40 dB below the speech (95th percentile), but never below the room tone (10th
    percentile) + 10 dB, so a phone take's -60 dBFS room counts as silence while a breath does not."""
    p95, floor = float(np.percentile(db, 95)), float(np.percentile(db, 10))
    return max(p95 - below_db, min(floor + 10.0, p95 - 15.0))


def silences(x, sr, below_db=40.0, min_s=0.25, hop_s=0.01):
    """[(t0, t1)] pauses at least min_s long, in seconds."""
    db = frame_db(x, sr, hop_s=hop_s)
    thr = silence_threshold(db, below_db)
    runs, start = [], None
    for i, q in enumerate(np.append(db < thr, False)):
        if q and start is None:
            start = i
        elif not q and start is not None:
            if (i - start) * hop_s >= min_s:
                runs.append((round(start * hop_s, 3), round(i * hop_s, 3)))
            start = None
    return runs


def chunk_bounds(duration_s, quiet, chunk_s=CHUNK_S):
    """Cut points in the middle of pauses so that no piece is longer than chunk_s when a pause allows it.
    -> [(t0, t1)] tiling [0, duration_s]."""
    if not chunk_s or chunk_s <= 0 or duration_s <= chunk_s or not quiet:
        return [(0.0, round(duration_s, 3))]
    mids = [(a + b) / 2 for a, b in quiet if 0 < (a + b) / 2 < duration_s]
    cuts, start, last = [], 0.0, None
    for m in mids:
        if m - start > chunk_s and last is not None and last > start:
            cuts.append(last)
            start = last
        last = m
    if duration_s - start > chunk_s and last is not None and last > start:
        cuts.append(last)
    edges = [0.0] + cuts + [duration_s]
    return [(round(a, 3), round(b, 3)) for a, b in zip(edges[:-1], edges[1:]) if b - a > 1e-3]


def fit(y, n):
    y = np.asarray(y, np.float32).reshape(-1)
    return y[:n] if len(y) >= n else np.concatenate([y, np.zeros(n - len(y), np.float32)])


def guard_pauses(y, ysr, x, sr, quiet, headroom_db=6.0, floor_db=-60.0, edge_s=0.05, hop_s=0.01):
    """In the pauses `quiet` of the performance x (shrunk by edge_s at both ends), turn the converted y down wherever it
    is louder than x + headroom_db (and than floor_db, so a studio-silent take does not gate the converted voice's own
    room down to digital silence), frame by frame (10 ms, linear between frames). Elsewhere y is untouched."""
    y = np.asarray(y, np.float32).reshape(-1).copy()
    if not quiet or not len(y):
        return y
    dy, dx = frame_db(y, ysr, hop_s=hop_s), frame_db(x, sr, hop_s=hop_s)
    n = min(len(dy), len(dx))
    gain_db = np.zeros(n)
    t = np.arange(n) * hop_s
    for a, b in quiet:
        m = (t >= a + edge_s) & (t <= b - edge_s)
        over = dy[:n] - np.maximum(dx[:n] + headroom_db, floor_db)
        gain_db[m] = np.minimum(0.0, -over[m])
    if not np.any(gain_db < 0):
        return y
    centres = (np.arange(n) * hop_s + 0.01) * ysr      # a frame's level covers its 20 ms window
    g = np.interp(np.arange(len(y)), centres, 10 ** (gain_db / 20.0), left=1.0, right=1.0)
    return (y * g).astype(np.float32)


def convert_in_pieces(x, sr, convert, chunk_s=CHUNK_S, min_piece_s=0.1, guard=True):
    """x mono at sr; convert(piece, sr) -> (y, ysr). Returns (y at ysr, exactly len(x)/sr seconds, pieces).
    Each piece lands at the sample it came from; a piece shorter than min_piece_s stays silent. guard: the pause
    guard (guard_pauses) on the result."""
    x = np.asarray(x, np.float32).reshape(-1)
    dur = len(x) / float(sr)
    quiet = silences(x, sr)
    pieces = chunk_bounds(dur, quiet, chunk_s)
    out, ysr = None, None
    for a, b in pieces:
        i0, i1 = int(round(a * sr)), int(round(b * sr))
        if (i1 - i0) < min_piece_s * sr:
            continue
        y, s = convert(x[i0:i1], sr)
        if out is None:
            ysr = int(s)
            out = np.zeros(int(round(dur * ysr)), np.float32)
        j0, n = int(round(a * ysr)), int(round(b * ysr)) - int(round(a * ysr))
        out[j0:j0 + n] = fit(y, n)[: max(0, len(out) - j0)]
    if out is None:
        return np.zeros(len(x), np.float32), int(sr), pieces
    if guard:
        out = guard_pauses(out, ysr, x, sr, quiet)
    return out, ysr, pieces
