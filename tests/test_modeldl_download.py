"""Model downloader: queue, .part + resume, sha/size verify, cancel, disk refusal, redirects. Fake transport only."""
import asyncio
import collections
import hashlib

from modeldl_fake import TOKEN, FakeHF, mini_catalog, stub_folder_paths
from soundstage import modeldl as M

DATA = bytes(range(256)) * 400          # 102,400 bytes
DATA2 = b"second-file-" * 5000
CHUNK = 4096


def make(tmp_path, monkeypatch, items=None, files=None, token=TOKEN, free=10 ** 15, **kw):
    models = stub_folder_paths(monkeypatch, tmp_path)
    items = items or [{"id": "a", "repo": "org/r", "path": "vae/a.safetensors", "folder": "vae"}]
    files = files or {("org/r", "vae/a.safetensors"): DATA}
    hf = FakeHF(files, **kw)
    Usage = collections.namedtuple("Usage", "total used free")
    dl = M.Downloader(mini_catalog(items), transport=hf, token_fn=lambda: (token, "saved" if token else None),
                      disk_usage=lambda p: Usage(0, 0, free), chunk=CHUNK)
    return dl, hf, models


def run(dl, ids):
    async def go():
        q = dl.enqueue(ids)
        await dl.idle()
        return q
    return asyncio.run(go())


def test_happy_path(tmp_path, monkeypatch):
    dl, hf, models = make(tmp_path, monkeypatch)
    queued, skipped = run(dl, ["a"])
    assert queued == ["a"] and skipped == []
    out = models / "vae" / "a.safetensors"
    assert out.read_bytes() == DATA and not (models / "vae" / "a.safetensors.part").exists()
    assert dl.done == [{"id": "a", "verified": "sha256"}] and dl.failed == []
    # already installed now: skipped
    assert run(dl, ["a"]) == ([], ["a"])


def test_x_linked_etag_used_when_catalog_sha_is_null_and_mismatch_deletes_part(tmp_path, monkeypatch):
    dl, hf, models = make(tmp_path, monkeypatch, corrupt=True)
    run(dl, ["a"])
    assert dl.failed and dl.failed[0]["code"] == "verify"
    assert not (models / "vae" / "a.safetensors").exists()
    assert not (models / "vae" / "a.safetensors.part").exists()


def test_catalog_sha_mismatch(tmp_path, monkeypatch):
    items = [{"id": "a", "repo": "org/r", "path": "vae/a.safetensors", "folder": "vae", "sha256": "0" * 64,
              "size": len(DATA)}]
    dl, hf, models = make(tmp_path, monkeypatch, items=items, etag=False)
    run(dl, ["a"])
    assert dl.failed[0]["code"] == "verify"
    assert not (models / "vae" / "a.safetensors.part").exists()


def test_size_mismatch(tmp_path, monkeypatch):
    items = [{"id": "a", "repo": "org/r", "path": "vae/a.safetensors", "folder": "vae",
              "sha256": hashlib.sha256(DATA).hexdigest(), "size": len(DATA) + 5}]
    dl, hf, models = make(tmp_path, monkeypatch, items=items, etag=False)
    run(dl, ["a"])
    assert dl.failed[0]["code"] == "verify"


def test_size_only_when_no_sha_anywhere(tmp_path, monkeypatch):
    items = [{"id": "a", "repo": "org/r", "path": "vae/a.safetensors", "folder": "vae"}]
    dl, hf, models = make(tmp_path, monkeypatch, items=items, etag=False)
    run(dl, ["a"])
    assert dl.done == [{"id": "a", "verified": "none"}]


def _seed_part(models, n):
    p = models / "vae" / "a.safetensors.part"
    p.write_bytes(DATA[:n])
    return p


def test_resume_206(tmp_path, monkeypatch):
    dl, hf, models = make(tmp_path, monkeypatch)
    _seed_part(models, 5000)
    run(dl, ["a"])
    gets = [c for c in hf.calls if c[0] == "GET"]
    assert gets[0][2].get("Range") == "bytes=5000-"
    assert (models / "vae" / "a.safetensors").read_bytes() == DATA
    assert dl.done[0]["verified"] == "sha256"


def test_resume_server_ignores_range_restarts(tmp_path, monkeypatch):
    dl, hf, models = make(tmp_path, monkeypatch, range_mode="200")
    _seed_part(models, 5000)
    run(dl, ["a"])
    assert (models / "vae" / "a.safetensors").read_bytes() == DATA


def test_resume_416_restarts(tmp_path, monkeypatch):
    dl, hf, models = make(tmp_path, monkeypatch, range_mode="416")
    _seed_part(models, 5000)
    run(dl, ["a"])
    gets = [c for c in hf.calls if c[0] == "GET"]
    assert gets[0][2].get("Range") and "Range" not in gets[1][2]
    assert (models / "vae" / "a.safetensors").read_bytes() == DATA


def test_part_bigger_than_file_is_dropped(tmp_path, monkeypatch):
    dl, hf, models = make(tmp_path, monkeypatch)
    (models / "vae" / "a.safetensors.part").write_bytes(DATA + b"extra")
    run(dl, ["a"])
    assert "Range" not in [c for c in hf.calls if c[0] == "GET"][0][2]
    assert (models / "vae" / "a.safetensors").read_bytes() == DATA


def test_disk_short_refuses_and_writes_nothing(tmp_path, monkeypatch):
    dl, hf, models = make(tmp_path, monkeypatch, free=10)
    run(dl, ["a"])
    assert dl.failed[0]["code"] == "disk" and "GB" in dl.failed[0]["message"]
    assert list((models / "vae").iterdir()) == []
    assert not [c for c in hf.calls if c[0] == "GET"]


def test_path_traversal_refused(tmp_path, monkeypatch):
    items = [{"id": "a", "repo": "org/r", "path": "vae/a.safetensors", "folder": "vae", "subdir": "../../x"}]
    dl, hf, models = make(tmp_path, monkeypatch, items=items)
    run(dl, ["a"])
    assert dl.failed[0]["code"] == "path" and hf.calls == []


def test_one_at_a_time_and_duplicate_skipped(tmp_path, monkeypatch):
    items = [{"id": "a", "repo": "org/r", "path": "vae/a.safetensors", "folder": "vae"},
             {"id": "b", "repo": "org/r", "path": "vae/b.safetensors", "folder": "vae"}]
    files = {("org/r", "vae/a.safetensors"): DATA, ("org/r", "vae/b.safetensors"): DATA2}
    dl, hf, models = make(tmp_path, monkeypatch, items=items, files=files)

    async def go():
        q1 = dl.enqueue(["a", "b"])
        q2 = dl.enqueue(["a", "b", "zzz"])
        await dl.idle()
        return q1, q2
    q1, q2 = asyncio.run(go())
    assert q1 == (["a", "b"], []) and q2 == ([], ["a", "b"])
    assert hf.max_active == 1
    assert [d["id"] for d in dl.done] == ["a", "b"]


def _cancel_run(tmp_path, monkeypatch, discard):
    holder = {}

    async def hook(offset):
        if offset >= 3 * CHUNK and not holder.get("done"):
            holder["done"] = True
            holder["dl"].cancel("a", discard=discard)
    dl, hf, models = make(tmp_path, monkeypatch, chunk_hook=hook)
    holder["dl"] = dl
    run(dl, ["a"])
    return dl, models


def test_cancel_keeps_part(tmp_path, monkeypatch):
    dl, models = _cancel_run(tmp_path, monkeypatch, discard=False)
    p = models / "vae" / "a.safetensors.part"
    assert p.exists() and 0 < p.stat().st_size < len(DATA)
    assert dl.failed[0]["code"] == "cancelled"
    assert M.item_state(dl.items["a"])["state"] == "partial"


def test_cancel_discard_deletes_part(tmp_path, monkeypatch):
    dl, models = _cancel_run(tmp_path, monkeypatch, discard=True)
    assert not (models / "vae" / "a.safetensors.part").exists()
    assert M.item_state(dl.items["a"])["state"] == "missing"


def test_cancel_queued_removes_it(tmp_path, monkeypatch):
    items = [{"id": "a", "repo": "org/r", "path": "vae/a.safetensors", "folder": "vae"},
             {"id": "b", "repo": "org/r", "path": "vae/b.safetensors", "folder": "vae"}]
    files = {("org/r", "vae/a.safetensors"): DATA, ("org/r", "vae/b.safetensors"): DATA2}
    dl, hf, models = make(tmp_path, monkeypatch, items=items, files=files)

    async def go():
        dl.enqueue(["a", "b"])
        assert dl.cancel("b") == ["b"]
        await dl.idle()
    asyncio.run(go())
    assert [d["id"] for d in dl.done] == ["a"] and not (models / "vae" / "b.safetensors").exists()


def test_redirect_to_cdn_drops_authorization(tmp_path, monkeypatch):
    dl, hf, models = make(tmp_path, monkeypatch, redirect_cdn=True)
    run(dl, ["a"])
    assert (models / "vae" / "a.safetensors").read_bytes() == DATA
    hf_calls = [c for c in hf.calls if c[1].startswith("https://huggingface.co/")]
    cdn_calls = [c for c in hf.calls if c[1].startswith("https://cdn.example/")]
    assert hf_calls and cdn_calls
    assert all(c[2].get("Authorization") == f"Bearer {TOKEN}" for c in hf_calls)
    assert all("Authorization" not in c[2] for c in cdn_calls)


def test_access_failure_stops_the_job(tmp_path, monkeypatch):
    dl, hf, models = make(tmp_path, monkeypatch, head_status={"org/r": 403})
    run(dl, ["a"])
    assert dl.failed[0]["code"] == "licence"
    assert not [c for c in hf.calls if c[0] == "GET"]


def test_progress_shape(tmp_path, monkeypatch):
    dl, hf, models = make(tmp_path, monkeypatch)
    seen = []

    async def hook(offset):
        seen.append(dl.progress())
    hf.chunk_hook = hook
    run(dl, ["a"])
    cur = seen[-1]["current"]
    assert set(cur) == {"id", "bytes", "total", "rate", "eta", "phase"} and cur["phase"] == "downloading"
    assert cur["total"] == len(DATA)
    assert dl.progress() == {"current": None, "queue": [], "done": [{"id": "a", "verified": "sha256"}], "failed": []}
