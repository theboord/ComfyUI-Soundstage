"""Model downloader: queue, .part + resume, sha/size verify, cancel, disk refusal, redirects. Fake transport only."""
import asyncio
import collections
import hashlib
import os

from modeldl_fake import TOKEN, FakeHF, mini_catalog, safetensors_bytes, stub_folder_paths
from soundstage import modeldl as M

DATA = safetensors_bytes(bytes(range(256)) * 400)          # ~102 KB, shaped like a safetensors file
DATA2 = safetensors_bytes(b"second-file-" * 5000)
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


def test_response_content_length_is_not_a_check(tmp_path, monkeypatch):
    # no sha256 and no X-Linked-Size, no catalog size: the response's own Content-Length proves nothing, so the
    # download is reported unverified_size (and had to pass the safetensors header check)
    items = [{"id": "a", "repo": "org/r", "path": "vae/a.safetensors", "folder": "vae"}]
    dl, hf, models = make(tmp_path, monkeypatch, items=items, etag=False)
    run(dl, ["a"])
    assert dl.done == [{"id": "a", "verified": "unverified_size"}]


def test_missing_size_garbage_body_fails_the_safetensors_check(tmp_path, monkeypatch):
    # no size known anywhere and the body is not a safetensors file (an error page served as octet-stream)
    files = {("org/r", "vae/a.safetensors"): b"Access denied by proxy. " * 200}
    dl, hf, models = make(tmp_path, monkeypatch, files=files, etag=False)
    run(dl, ["a"])
    assert dl.failed[0]["code"] == "verify" and dl.done == []
    assert not (models / "vae" / "a.safetensors").exists()
    assert not (models / "vae" / "a.safetensors.part").exists()


def test_catalog_size_must_be_within_one_percent_or_the_rounding_slack(tmp_path, monkeypatch):
    # nothing exact is known: within 1 % of the catalog figure, but never tighter than SIZE_SLACK (5 MB, half the
    # catalog's 0.01 GB rounding)
    gb = 1_000_000_000
    assert M.size_within_pct(int(10 * gb * 1.009), 10 * gb) and not M.size_within_pct(int(10 * gb * 1.02), 10 * gb)
    # ltx25-temporal-x2 / flux2-vae: 0.26 / 0.34 GB in the catalog, a genuine file up to 5 MB away still passes
    assert M.size_within_pct(260_000_000 + 4_000_000, 260_000_000)
    assert M.size_within_pct(260_000_000 - 4_000_000, 260_000_000)
    assert M.size_within_pct(340_000_000 + 4_900_000, 340_000_000)
    assert not M.size_within_pct(260_000_000 + 6_000_000, 260_000_000)
    # a real download 6 MB away from the catalog figure is refused
    items = [{"id": "a", "repo": "org/r", "path": "vae/a.safetensors", "folder": "vae", "size": len(DATA) + 6_000_000}]
    dl, hf, models = make(tmp_path, monkeypatch, items=items, etag=False)
    run(dl, ["a"])
    assert dl.failed[0]["code"] == "verify"
    # and one 4 MB away (inside the rounding) is installed
    items[0]["size"] = len(DATA) + 4_000_000
    dl, hf, models = make(tmp_path / "b", monkeypatch, items=items, etag=False)
    run(dl, ["a"])
    assert dl.done == [{"id": "a", "verified": "size"}] and dl.failed == []
    assert (models / "vae" / "a.safetensors").read_bytes() == DATA


def test_captive_portal_html_is_refused_and_nothing_is_written(tmp_path, monkeypatch):
    dl, hf, models = make(tmp_path, monkeypatch, portal=True)
    run(dl, ["a"])
    assert dl.failed[0]["code"] == "not_model" and "web page" in dl.failed[0]["message"]
    assert list((models / "vae").iterdir()) == []
    # a resume that lands on the portal leaves the good .part alone
    p = _seed_part(models, 5000)
    run(dl, ["a"])
    assert dl.failed[-1]["code"] == "not_model" and p.read_bytes() == DATA[:5000]


def test_text_content_type_refused_even_with_the_right_size(tmp_path, monkeypatch):
    dl, hf, models = make(tmp_path, monkeypatch, content_type="text/plain")
    run(dl, ["a"])
    assert dl.failed[0]["code"] == "not_model"


def test_cut_off_transfer_keeps_the_part_for_resume(tmp_path, monkeypatch):
    dl, hf, models = make(tmp_path, monkeypatch, short=7000)
    run(dl, ["a"])
    assert dl.failed[0]["code"] == "network"
    assert (models / "vae" / "a.safetensors.part").stat().st_size == 7000


def test_catalog_size_checked_when_no_header_gives_one(tmp_path, monkeypatch):
    items = [{"id": "a", "repo": "org/r", "path": "vae/a.safetensors", "folder": "vae", "size": len(DATA)}]
    dl, hf, models = make(tmp_path, monkeypatch, items=items, etag=False, length=False)
    run(dl, ["a"])
    assert dl.done == [{"id": "a", "verified": "size"}]


def test_catalog_size_mismatch_without_sha_is_refused(tmp_path, monkeypatch):
    # the catalog's rounded size is far off (a truncated or wrong file): not installed, .part deleted
    items = [{"id": "a", "repo": "org/r", "path": "vae/a.safetensors", "folder": "vae",
              "size": len(DATA) + 2 * M.SIZE_SLACK}]
    dl, hf, models = make(tmp_path, monkeypatch, items=items, etag=False, length=False)
    run(dl, ["a"])
    assert dl.failed[0]["code"] == "verify" and dl.done == []
    assert not (models / "vae" / "a.safetensors").exists()
    assert not (models / "vae" / "a.safetensors.part").exists()


def test_no_size_anywhere_is_reported_as_none(tmp_path, monkeypatch):
    dl, hf, models = make(tmp_path, monkeypatch, etag=False, length=False)
    run(dl, ["a"])
    assert dl.done == [{"id": "a", "verified": "unverified_size"}]


def test_wrong_size_against_the_verified_size_is_not_skipped_and_gets_replaced(tmp_path, monkeypatch):
    items = [{"id": "a", "repo": "org/r", "path": "vae/a.safetensors", "folder": "vae", "size": len(DATA)}]
    dl, hf, models = make(tmp_path, monkeypatch, items=items)
    run(dl, ["a"])                                   # a verified download records the exact size
    out = models / "vae" / "a.safetensors"
    out.write_bytes(DATA[:100])                       # later truncated
    st = M.item_state(dl.items["a"])
    assert st["state"] == "missing" and st.get("wrong_size")
    assert run(dl, ["a"]) == (["a"], [])
    assert out.read_bytes() == DATA


def test_good_file_off_the_rounded_catalog_size_is_installed_and_never_requeued(tmp_path, monkeypatch):
    # the catalog figure is rounded GB; the real file is more than 5 MB away from it
    approx = len(DATA) + 6_000_000
    items = [{"id": "a", "repo": "org/r", "path": "vae/a.safetensors", "folder": "vae", "size": approx}]
    dl, hf, models = make(tmp_path, monkeypatch, items=items)
    (models / "vae" / "a.safetensors").write_bytes(DATA)        # a correct file the user already has
    st = M.item_state(dl.items["a"])
    assert st["state"] == "installed" and st.get("size_note") and not st.get("wrong_size")
    assert run(dl, ["a"]) == ([], ["a"]) and hf.calls == []
    # and a file the App downloads itself (verified against X-Linked-Size) reads installed afterwards, exactly
    (models / "vae" / "a.safetensors").unlink()
    assert run(dl, ["a"]) == (["a"], [])
    assert dl.done[-1]["id"] == "a" and dl.failed == []
    st = M.item_state(dl.items["a"])
    assert st == {"state": "installed", "have_bytes": len(DATA)}
    n = len(hf.calls)
    assert run(dl, ["a"]) == ([], ["a"]) and len(hf.calls) == n


def test_part_symlink_out_of_the_folder_is_never_written_through(tmp_path, monkeypatch):
    dl, hf, models = make(tmp_path, monkeypatch)
    outside = tmp_path / "outside"
    outside.mkdir()
    victim = outside / "victim"
    victim.write_bytes(b"keep me")
    os.symlink(victim, models / "vae" / "a.safetensors.part")
    run(dl, ["a"])
    assert victim.read_bytes() == b"keep me"
    out = models / "vae" / "a.safetensors"
    assert out.read_bytes() == DATA and not out.is_symlink()


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


def test_resume_wrong_content_range_restarts(tmp_path, monkeypatch):
    # a 206 that starts somewhere other than the bytes we have must not be appended
    dl, hf, models = make(tmp_path, monkeypatch, range_mode="badrange")
    _seed_part(models, 5000)
    run(dl, ["a"])
    gets = [c for c in hf.calls if c[0] == "GET"]
    assert gets[0][2].get("Range") == "bytes=5000-" and "Range" not in gets[1][2]
    assert (models / "vae" / "a.safetensors").read_bytes() == DATA
    assert dl.done[0]["verified"] == "sha256"


def test_complete_part_is_finalised_without_downloading(tmp_path, monkeypatch):
    dl, hf, models = make(tmp_path, monkeypatch)
    _seed_part(models, len(DATA))
    run(dl, ["a"])
    assert not [c for c in hf.calls if c[0] == "GET"]
    assert (models / "vae" / "a.safetensors").read_bytes() == DATA
    assert dl.done == [{"id": "a", "verified": "sha256"}]


def test_complete_part_finalised_on_416_when_size_unknown_up_front(tmp_path, monkeypatch):
    # no X-Linked-Size on HEAD: the Range request (If-Range: the validator noted when the part started) gets 416
    # "bytes */N" with N == what we have -> keep it, after the safetensors check
    dl, hf, models = make(tmp_path, monkeypatch, etag=False)
    _seed_part(models, len(DATA))
    _seed_meta(models, '"v1"')
    run(dl, ["a"])
    gets = [c for c in hf.calls if c[0] == "GET"]
    assert len(gets) == 1 and gets[0][2].get("Range") == f"bytes={len(DATA)}-" and gets[0][2]["If-Range"] == '"v1"'
    assert (models / "vae" / "a.safetensors").read_bytes() == DATA
    assert dl.done == [{"id": "a", "verified": "unverified_size"}]


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


# ---------------------------------------------------------------- resume: If-Range with the validator from the start

def _seed_meta(models, validator):
    (models / "vae" / "a.safetensors.part.meta").write_text('{"validator": %s}' % __import__("json").dumps(validator))


def test_first_download_records_the_validator_and_success_clears_it(tmp_path, monkeypatch):
    holder = {}

    async def hook(offset):
        if offset and "meta" not in holder:
            holder["meta"] = M.read_meta(models / "vae" / "a.safetensors.part")
    dl, hf, models = make(tmp_path, monkeypatch, chunk_hook=hook)
    run(dl, ["a"])
    assert holder["meta"] == '"v1"'
    assert not (models / "vae" / "a.safetensors.part.meta").exists()


def test_resume_sends_if_range_and_appends_when_unchanged(tmp_path, monkeypatch):
    items = [{"id": "a", "repo": "org/r", "path": "vae/a.safetensors", "folder": "vae", "size": len(DATA)}]
    dl, hf, models = make(tmp_path, monkeypatch, items=items, etag=False)
    _seed_part(models, 5000)
    _seed_meta(models, '"v1"')
    run(dl, ["a"])
    gets = [c for c in hf.calls if c[0] == "GET"]
    assert len(gets) == 1 and gets[0][2]["Range"] == "bytes=5000-" and gets[0][2]["If-Range"] == '"v1"'
    assert (models / "vae" / "a.safetensors").read_bytes() == DATA
    assert dl.done == [{"id": "a", "verified": "size"}]


def test_resume_with_changed_upstream_restarts_cleanly(tmp_path, monkeypatch):
    # the .part came from an older upload (v0); upstream is now v1 with different bytes, and there's no sha256 to
    # catch a mix: the stale If-Range gets a 200 and the file is written from byte 0, never appended
    old = safetensors_bytes(b"OLD-UPLOAD" * 9000)
    items = [{"id": "a", "repo": "org/r", "path": "vae/a.safetensors", "folder": "vae", "size": len(DATA)}]
    dl, hf, models = make(tmp_path, monkeypatch, items=items, etag=False, version="v1")
    p = models / "vae" / "a.safetensors.part"
    p.write_bytes(old[:5000])
    _seed_meta(models, '"v0"')
    run(dl, ["a"])
    gets = [c for c in hf.calls if c[0] == "GET"]
    assert gets[0][2]["If-Range"] == '"v0"'
    assert (models / "vae" / "a.safetensors").read_bytes() == DATA
    assert dl.done == [{"id": "a", "verified": "size"}]


def test_resume_with_a_changed_206_validator_restarts(tmp_path, monkeypatch):
    # a server that ignores If-Range but answers 206 with a different ETag: not appended
    items = [{"id": "a", "repo": "org/r", "path": "vae/a.safetensors", "folder": "vae", "size": len(DATA)}]
    dl, hf, models = make(tmp_path, monkeypatch, items=items, etag=False, version="v2")
    _seed_part(models, 5000)
    _seed_meta(models, '"v2"')
    hf.version = "v2"
    real = hf._serve

    def serve(repo, path, headers):
        h = {k: v for k, v in headers.items() if k != "If-Range"}
        r = real(repo, path, h)
        if r.status == 206:
            r.headers["etag"] = '"v3"'
        return r
    hf._serve = serve
    run(dl, ["a"])
    gets = [c for c in hf.calls if c[0] == "GET"]
    assert len(gets) == 2 and "Range" not in gets[1][2]
    assert (models / "vae" / "a.safetensors").read_bytes() == DATA


def test_part_without_validator_or_sha_starts_over(tmp_path, monkeypatch):
    items = [{"id": "a", "repo": "org/r", "path": "vae/a.safetensors", "folder": "vae", "size": len(DATA)}]
    dl, hf, models = make(tmp_path, monkeypatch, items=items, etag=False)
    _seed_part(models, 5000)
    run(dl, ["a"])
    gets = [c for c in hf.calls if c[0] == "GET"]
    assert len(gets) == 1 and "Range" not in gets[0][2]
    assert (models / "vae" / "a.safetensors").read_bytes() == DATA


# ---------------------------------------------------------------- cancel edge cases

def test_cancel_during_hashing_never_starts_the_get(tmp_path, monkeypatch):
    for discard in (False, True):
        sub = tmp_path / str(discard)
        dl, hf, models = make(sub, monkeypatch)
        p = _seed_part(models, 5000)
        real = M._hash_file

        def hashing(path, dl=dl):
            dl.cancel("a", discard=discard)
            return real(path)
        monkeypatch.setattr(M, "_hash_file", hashing)
        run(dl, ["a"])
        assert not [c for c in hf.calls if c[0] == "GET"]
        assert dl.failed[0]["code"] == "cancelled"
        assert p.exists() is (not discard)
        monkeypatch.setattr(M, "_hash_file", real)


def test_discard_works_for_queued_ids(tmp_path, monkeypatch):
    items = [{"id": "a", "repo": "org/r", "path": "vae/a.safetensors", "folder": "vae"},
             {"id": "b", "repo": "org/r", "path": "vae/b.safetensors", "folder": "vae"}]
    files = {("org/r", "vae/a.safetensors"): DATA, ("org/r", "vae/b.safetensors"): DATA2}
    dl, hf, models = make(tmp_path, monkeypatch, items=items, files=files)
    pb = models / "vae" / "b.safetensors.part"
    pb.write_bytes(DATA2[:100])
    (models / "vae" / "b.safetensors.part.meta").write_text('{"validator": "\\"v1\\""}')

    async def go():
        dl.enqueue(["a", "b"])
        assert dl.cancel("b", discard=True) == ["b"]
        await dl.idle()
    asyncio.run(go())
    assert not pb.exists() and not (models / "vae" / "b.safetensors.part.meta").exists()
    assert [d["id"] for d in dl.done] == ["a"]


def test_queued_id_dropped_from_a_reloaded_catalog_is_skipped(tmp_path, monkeypatch):
    items = [{"id": "a", "repo": "org/r", "path": "vae/a.safetensors", "folder": "vae"},
             {"id": "b", "repo": "org/r", "path": "vae/b.safetensors", "folder": "vae"}]
    files = {("org/r", "vae/a.safetensors"): DATA, ("org/r", "vae/b.safetensors"): DATA2}
    dl, hf, models = make(tmp_path, monkeypatch, items=items, files=files)

    async def go():
        dl.enqueue(["a", "b"])
        dl.set_catalog(mini_catalog(items[:1]))
        await dl.idle()
    asyncio.run(go())
    assert [d["id"] for d in dl.done] == ["a"] and dl.failed == []


# ---------------------------------------------------------------- a second models folder (extra_model_paths.yaml)

def test_model_in_a_second_models_folder_is_installed_and_not_downloaded(tmp_path, monkeypatch):
    extra = tmp_path / "shared_models"
    models = stub_folder_paths(monkeypatch, tmp_path, extra=extra)
    (extra / "vae" / "a.safetensors").write_bytes(DATA)
    hf = FakeHF({("org/r", "vae/a.safetensors"): DATA})
    Usage = collections.namedtuple("Usage", "total used free")
    dl = M.Downloader(mini_catalog([{"id": "a", "repo": "org/r", "path": "vae/a.safetensors", "folder": "vae"}]),
                      transport=hf, token_fn=lambda: (None, None), disk_usage=lambda p: Usage(0, 0, 10 ** 15))
    assert M.item_state(dl.items["a"]) == {"state": "installed", "have_bytes": len(DATA)}
    assert run(dl, ["a"]) == ([], ["a"]) and hf.calls == []
    # downloads still go to the first folder, and a wrong-size copy in the second one doesn't count
    (extra / "vae" / "a.safetensors").write_bytes(DATA[:10])
    M.record_verified(dl.items["a"], len(DATA), None)
    st = M.item_state(dl.items["a"])
    assert st["state"] == "missing" and st.get("wrong_size")
    assert run(dl, ["a"]) == (["a"], [])
    assert (models / "vae" / "a.safetensors").read_bytes() == DATA
    assert M.item_state(dl.items["a"])["state"] == "installed"
