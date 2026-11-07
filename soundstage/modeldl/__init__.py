"""Model downloader: get the App's model files from Hugging Face inside the App (docs/models.md).

GET  /soundstage/models/status      -> {catalog_version, groups, licences, items:[...+state, have_bytes], installed_files,
                                        signed_in, user, token_source, free_bytes, busy}
POST /soundstage/models/access      {ids}                                  -> {results:{id:code}, messages:{id:str}}
POST /soundstage/models/download    {ids, confirm:true, accepted_licences} -> {queued, skipped, refused:{id:reason}}
GET  /soundstage/models/progress    -> {current, queue, done, failed}
POST /soundstage/models/cancel      {id?, all?, discard?}                  -> {cancelled}
POST /soundstage/models/token       {token}                                -> {signed_in, user} | 400
POST /soundstage/models/token/remove                                       -> {signed_in, token_source}
GET  /soundstage/models/tiers       -> {tiers}

Rules this module keeps:
  * The browser only sends catalog ids. Paths and URLs come from catalog.json; every target is checked to stay
    inside its ComfyUI models folder (no "..", no symlink out).
  * The Hugging Face token never leaves the server: no route returns it, it's never logged, error messages are
    fixed strings. It is sent only to the huggingface.co host, never to the CDN a download redirects to.
    Saved at user/soundstage/hf_token with mode 600.
  * One download at a time, into <name>.part, verified (size + sha256) and then renamed into place.
  * All network access goes through a Transport object, so the tests run against a fake one.
"""
from __future__ import annotations

import asyncio
import collections
import hashlib
import json
import logging
import os
import re
import shutil
import time
from pathlib import Path
from urllib.parse import urljoin, urlparse

log = logging.getLogger("soundstage.modeldl")

# One catalog for the server and the panel (the panel reads it too, to show the list when no server answers).
CATALOG_PATH = Path(__file__).resolve().parents[2] / "web" / "models" / "catalog.json"
HF_DEFAULT = "https://huggingface.co"
ALLOWED_FOLDERS = {"diffusion_models", "text_encoders", "vae", "loras", "latent_upscale_models", "checkpoints",
                   "background_removal"}
GIB = 1 << 30
DISK_MARGIN = 2 * GIB
CHUNK = 8 << 20
ACCESS_TTL = 60.0
MAX_HOPS = 5

_ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
_REPO_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*$")
_SHA_RE = re.compile(r"^[0-9a-f]{64}$")
_LOOPBACK_RE = re.compile(r"^http://127\.0\.0\.1:\d{1,5}$")
_TOKEN_RE = re.compile(r"^[\x21-\x7e]{8,400}$")   # printable ASCII, no spaces/newlines (no header injection)


# --------------------------------------------------------------------------------------------- endpoint

def hf_base() -> str:
    """https://huggingface.co. Tests may point it at a loopback server; any other override is ignored so a config
    value can never send the token somewhere else."""
    o = os.environ.get("SOUNDSTAGE_HF_ENDPOINT", "").rstrip("/")
    return o if _LOOPBACK_RE.match(o) else HF_DEFAULT


def resolve_url(item: dict) -> str:
    return f"{hf_base()}/{item['repo']}/resolve/{item.get('revision') or 'main'}/{item['path']}"


def repo_url(repo: str) -> str:
    return f"{HF_DEFAULT}/{repo}"


# --------------------------------------------------------------------------------------------- catalog

def _rel_ok(p: str, allow_empty: bool = False) -> bool:
    if not isinstance(p, str):
        return False
    if p == "":
        return allow_empty
    if p.startswith("/") or "\\" in p or "\x00" in p or re.match(r"^[A-Za-z]:", p):
        return False
    return all(seg not in ("", ".", "..") for seg in p.split("/"))


def validate(cat: dict) -> list[str]:
    """Every problem in a catalog, as sentences ([] = valid)."""
    errs: list[str] = []
    if not isinstance(cat, dict) or cat.get("schema") != 1:
        return ["schema must be 1"]
    groups = {g.get("id") for g in cat.get("groups") or []}
    lic = cat.get("licences") or {}
    for k, v in lic.items():
        rl = v.get("revenue_limit_usd")
        if rl is not None and not isinstance(rl, int):
            errs.append(f"licence {k}: revenue_limit_usd must be an int or null")
        if not isinstance(v.get("geo_excluded", []), list):
            errs.append(f"licence {k}: geo_excluded must be a list")
        if not str(v.get("url", "")).startswith("https://"):
            errs.append(f"licence {k}: url must be https")
    seen: set[str] = set()
    for it in cat.get("items") or []:
        i = it.get("id")
        if not isinstance(i, str) or not _ID_RE.match(i):
            errs.append(f"bad id {i!r}")
            continue
        if i in seen:
            errs.append(f"{i}: duplicate id")
        seen.add(i)
        if not isinstance(it.get("repo"), str) or not _REPO_RE.match(it["repo"]):
            errs.append(f"{i}: repo must be owner/name")
        if not _rel_ok(it.get("path")):
            errs.append(f"{i}: path must be relative with no '..'")
        if not _rel_ok(it.get("revision") or "main") or "/" in (it.get("revision") or "main"):
            errs.append(f"{i}: bad revision")
        if it.get("folder") not in ALLOWED_FOLDERS:
            errs.append(f"{i}: folder {it.get('folder')!r} is not allowed")
        if not _rel_ok(it.get("subdir", ""), allow_empty=True):
            errs.append(f"{i}: subdir must be relative with no '..'")
        sn = it.get("saved_name")
        if not isinstance(sn, str) or not _rel_ok(sn) or "/" in sn or not sn.endswith(".safetensors"):
            errs.append(f"{i}: saved_name must be one segment ending .safetensors")
        sz = it.get("size")
        if sz is not None and (not isinstance(sz, int) or isinstance(sz, bool) or sz <= 0):
            errs.append(f"{i}: size must be a positive int or null")
        sh = it.get("sha256")
        if sh is not None and (not isinstance(sh, str) or not _SHA_RE.match(sh)):
            errs.append(f"{i}: sha256 must be 64 lower-case hex or null")
        ls = it.get("licences")
        if not isinstance(ls, list) or not ls or any(k not in lic for k in ls):
            errs.append(f"{i}: licences must name keys in licences")
        if it.get("group") not in groups:
            errs.append(f"{i}: unknown group {it.get('group')!r}")
    for s, ids in (cat.get("sets") or {}).items():
        for i in ids:
            if i not in seen:
                errs.append(f"set {s}: unknown id {i}")
    for t in cat.get("tiers") or []:
        for s in t.get("sets") or []:
            if s not in (cat.get("sets") or {}):
                errs.append(f"tier {t.get('id')}: unknown set {s}")
    return errs


_CAT_CACHE: dict = {}


def load_catalog(path: Path | None = None) -> dict:
    p = Path(path or CATALOG_PATH)
    key = (str(p), p.stat().st_mtime_ns)
    if _CAT_CACHE.get("key") != key:
        cat = json.loads(p.read_text())
        errs = validate(cat)
        if errs:
            raise ValueError("catalog.json: " + "; ".join(errs[:5]))
        _CAT_CACHE.update(key=key, cat=cat)
    return _CAT_CACHE["cat"]


def items_by_id(cat: dict) -> dict:
    return {it["id"]: it for it in cat["items"]}


def folder_root(folder: str) -> Path | None:
    if folder not in ALLOWED_FOLDERS:
        return None
    try:
        import folder_paths
        paths = folder_paths.get_folder_paths(folder)
    except Exception:  # noqa: BLE001 - folder not registered on this ComfyUI
        return None
    return Path(paths[0]) if paths else None


def target(item: dict) -> Path:
    """Where the file goes. Raises ValueError if the folder isn't allowed or the path would leave it."""
    root = folder_root(item.get("folder", ""))
    if root is None:
        raise ValueError("folder not allowed")
    sub, name = item.get("subdir", "") or "", item.get("saved_name", "")
    if not _rel_ok(sub, allow_empty=True) or not _rel_ok(name) or "/" in name:
        raise ValueError("path escapes the models folder")
    rr = root.resolve()
    t = (root / sub / name) if sub else (root / name)
    # resolve the parent too: a symlinked subdir pointing out of the folder is refused
    tr = t.parent.resolve() / t.name
    if t.exists() or t.is_symlink():
        tr = t.resolve()
    try:
        tr.relative_to(rr)
    except ValueError:
        raise ValueError("path escapes the models folder") from None
    return tr


def part_path(t: Path) -> Path:
    return t.with_name(t.name + ".part")


def item_state(item: dict) -> dict:
    """installed / partial / missing (no hashing: status must be quick). other_build is worked out in the browser."""
    try:
        t = target(item)
    except ValueError:
        return {"state": "missing", "have_bytes": 0}
    if t.is_file():
        sz = item.get("size") if item.get("sha256") else None   # sizes are exact only once filled
        if sz is None or t.stat().st_size == sz:
            return {"state": "installed", "have_bytes": t.stat().st_size}
    p = part_path(t)
    if p.is_file():
        return {"state": "partial", "have_bytes": p.stat().st_size}
    return {"state": "missing", "have_bytes": 0}


def installed_files() -> dict:
    out = {}
    try:
        import folder_paths
    except ImportError:
        return out
    for f in sorted(ALLOWED_FOLDERS):
        try:
            out[f] = [str(x).replace("\\", "/") for x in folder_paths.get_filename_list(f)]
        except Exception:  # noqa: BLE001
            out[f] = []
    return out


def pick_tier(cat: dict, vram_gb: float, ram_gb: float) -> dict | None:
    for t in cat.get("tiers") or []:
        if vram_gb >= t.get("min_vram_gb", 0) and ram_gb >= t.get("min_ram_gb", 0):
            return t
    return None


def ids_for_tier(cat: dict, tier_id: str) -> list[str]:
    t = next((t for t in cat.get("tiers") or [] if t.get("id") == tier_id), None)
    out: list[str] = []
    for s in (t or {}).get("sets") or []:
        for i in cat["sets"].get(s, []):
            if i not in out:
                out.append(i)
    return out


# --------------------------------------------------------------------------------------------- token

def token_path() -> Path:
    import folder_paths
    return Path(folder_paths.get_user_directory()) / "soundstage" / "hf_token"


def clean_token(tok) -> str | None:
    if not isinstance(tok, str):
        return None
    tok = tok.strip()
    return tok if _TOKEN_RE.match(tok) else None


def save_token(tok: str) -> None:
    tok = clean_token(tok)
    if not tok:
        raise ValueError("That doesn't look like a Hugging Face token")
    p = token_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(p.parent, 0o700)
    tmp = p.with_name(p.name + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(fd, tok.encode())
    finally:
        os.close(fd)
    os.replace(tmp, p)
    os.chmod(p, 0o600)


def remove_token() -> bool:
    try:
        token_path().unlink()
        return True
    except FileNotFoundError:
        return False


def load_token() -> tuple[str | None, str | None]:
    """(token, source): the saved file, then HF_TOKEN, then the huggingface-cli login file (read only)."""
    try:
        t = clean_token(token_path().read_text())
        if t:
            return t, "saved"
    except Exception:  # noqa: BLE001
        pass
    t = clean_token(os.environ.get("HF_TOKEN", ""))
    if t:
        return t, "environment"
    try:
        t = clean_token((Path.home() / ".cache" / "huggingface" / "token").read_text())
        if t:
            return t, "hf_cli"
    except Exception:  # noqa: BLE001
        pass
    return None, None


def fingerprint(tok: str | None) -> str:
    return hashlib.sha256(tok.encode()).hexdigest()[:8] if tok else "-"


# --------------------------------------------------------------------------------------------- transport

class Transport:
    """The only network access. open(method, url, headers, timeout) -> response with .status, .headers (lower-case
    keys), async chunks(n), async read(limit), close(). Never follows redirects."""

    def __init__(self):
        self._session = None

    async def _s(self):
        import aiohttp
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=None, sock_connect=15, sock_read=60), auto_decompress=False)
        return self._session

    async def open(self, method: str, url: str, headers: dict, timeout: float | None = None):
        import aiohttp
        s = await self._s()
        kw = {"allow_redirects": False, "headers": headers}
        if timeout:
            kw["timeout"] = aiohttp.ClientTimeout(total=timeout)
        r = await s.request(method, url, **kw)
        return _AioResp(r)


class _AioResp:
    def __init__(self, r):
        self._r = r
        self.status = r.status
        self.headers = {k.lower(): v for k, v in r.headers.items()}

    async def chunks(self, n):
        async for c in self._r.content.iter_chunked(n):
            yield c

    async def read(self, limit=1 << 20):
        return await self._r.content.read(limit)

    def close(self):
        self._r.release()


def _is_hf_host(url: str) -> bool:
    a, b = urlparse(url), urlparse(hf_base())
    return (a.scheme, a.hostname, a.port) == (b.scheme, b.hostname, b.port)


def _headers(url: str, token: str | None, extra: dict | None = None) -> dict:
    """The one place headers are built. Authorization goes to the Hugging Face host only."""
    h = {"User-Agent": "ComfyUI-Soundstage-modeldl/1", "Accept-Encoding": "identity"}
    if token and _is_hf_host(url):
        h["Authorization"] = f"Bearer {token}"
    if extra:
        h.update(extra)
    return h


async def whoami(transport, token: str) -> str | None:
    """The account name for a token, or None if Hugging Face doesn't accept it."""
    url = f"{hf_base()}/api/whoami-v2"
    r = await transport.open("GET", url, _headers(url, token), timeout=15)
    try:
        if r.status != 200:
            return None
        try:
            j = json.loads((await r.read(1 << 16)).decode("utf-8", "replace"))
        except ValueError:
            return None
        return str(j.get("name") or "") or "(signed in)"
    finally:
        r.close()


MESSAGES = {
    "ok": "Ready",
    "sign_in": "Sign in with your Hugging Face token",
    "licence": "Accept the licence on Hugging Face, then check again",
    "not_found": "Hugging Face can't find this file",
    "error": "Couldn't reach Hugging Face",
    "network": "The connection dropped. Click Download again to resume.",
    "disk": "Not enough free disk space",
    "verify": "The downloaded file didn't match; it was deleted",
    "path": "That file would go outside the models folder",
    "revision": "The pinned version of this file is gone from Hugging Face",
}


def classify(status: int, gated: bool, has_token: bool, error_code: str | None = None) -> str:
    ec = (error_code or "").strip()
    if ec == "GatedRepo":
        return "licence" if has_token else "sign_in"
    if status in (200, 301, 302, 303, 307, 308):
        return "ok"
    if status == 401:
        return "sign_in" if (gated or not has_token) else "not_found"
    if status == 403:
        return "licence"
    if status == 404:
        return "not_found"
    return "error"


async def head_item(transport, item: dict, token: str | None) -> tuple[str, dict]:
    url = resolve_url(item)
    try:
        r = await transport.open("HEAD", url, _headers(url, token), timeout=15)
    except Exception as e:  # noqa: BLE001 - message never includes headers
        log.info("modeldl: HEAD %s failed (%s)", item["id"], type(e).__name__)
        return "error", {}
    try:
        return classify(r.status, bool(item.get("gated")), bool(token), r.headers.get("x-error-code")), dict(r.headers)
    finally:
        r.close()


def linked_meta(headers: dict) -> tuple[str | None, int | None]:
    """(sha256, size) from Hugging Face's X-Linked-Etag / X-Linked-Size (LFS files)."""
    et = (headers.get("x-linked-etag") or "").strip().strip('"').lower()
    if et.startswith("w/"):
        et = et[2:].strip('"')
    sha = et if _SHA_RE.match(et) else None
    try:
        size = int(headers.get("x-linked-size") or "") or None
    except ValueError:
        size = None
    return sha, size


# --------------------------------------------------------------------------------------------- downloader

class JobError(Exception):
    def __init__(self, code: str, message: str | None = None):
        super().__init__(code)
        self.code, self.message = code, message or MESSAGES.get(code, code)


class Downloader:
    def __init__(self, catalog: dict, transport=None, token_fn=load_token, disk_usage=shutil.disk_usage,
                 chunk: int = CHUNK, clock=time.monotonic):
        self.cat = catalog
        self.items = items_by_id(catalog)
        self.transport = transport or Transport()
        self.token_fn = token_fn
        self.disk_usage = disk_usage
        self.chunk = chunk
        self.clock = clock
        self.queue: collections.deque = collections.deque()
        self.current: dict | None = None
        self.done: list = []
        self.failed: list = []
        self._task: asyncio.Task | None = None
        self._cancel: dict | None = None
        self._access: dict = {}

    # ---- access, cached per (repo, token fingerprint) for a minute, one HEAD per repo
    def clear_access_cache(self):
        self._access.clear()

    async def access(self, ids: list[str]) -> dict:
        tok, _src = self.token_fn()
        fp = fingerprint(tok)
        by_repo: dict = {}
        for i in ids:
            it = self.items.get(i)
            if it:
                by_repo.setdefault(it["repo"], []).append(it)
        out = {}
        now = self.clock()
        for repo, its in by_repo.items():
            hit = self._access.get((repo, fp))
            if hit and now - hit[1] < ACCESS_TTL:
                code = hit[0]
            else:
                code, _h = await head_item(self.transport, its[0], tok)
                self._access[(repo, fp)] = (code, now)
            for it in its:
                out[it["id"]] = code
        return out

    # ---- queue
    def enqueue(self, ids: list[str]) -> tuple[list, list]:
        queued, skipped = [], []
        for i in ids:
            it = self.items.get(i)
            if it is None:
                continue
            running = self.current and self.current["id"] == i
            if i in self.queue or running or item_state(it)["state"] == "installed":
                skipped.append(i)
                continue
            self.queue.append(i)
            queued.append(i)
        if self.queue and (self._task is None or self._task.done()):
            self._task = asyncio.get_running_loop().create_task(self._worker())
        return queued, skipped

    async def idle(self):
        while self._task is not None and not self._task.done():
            await asyncio.shield(self._task)

    @property
    def busy(self) -> bool:
        return bool(self.current or self.queue)

    def cancel(self, id: str | None = None, all: bool = False, discard: bool = False) -> list:
        out = []
        if all:
            out += list(self.queue)
            self.queue.clear()
        elif id and id in self.queue:
            self.queue.remove(id)
            out.append(id)
        if self.current and (all or id == self.current["id"]):
            self._cancel = {"id": self.current["id"], "discard": bool(discard)}
            out.append(self.current["id"])
        return out

    def progress(self) -> dict:
        c = None
        if self.current:
            c = {k: self.current.get(k) for k in ("id", "bytes", "total", "rate", "eta", "phase")}
        return {"current": c, "queue": list(self.queue), "done": list(self.done), "failed": list(self.failed)}

    async def _worker(self):
        while self.queue:
            i = self.queue.popleft()
            it = self.items[i]
            self.current = {"id": i, "bytes": 0, "total": it.get("size"), "rate": 0.0, "eta": None, "phase": "checking"}
            self._cancel = None
            try:
                verified = await self.run_one(it)
                self.done.append({"id": i, "verified": verified})
            except JobError as e:
                self.failed.append({"id": i, "code": e.code, "message": e.message})
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001 - never echo details (they could hold a URL); log the type only
                log.warning("modeldl: %s failed (%s)", i, type(e).__name__)
                self.failed.append({"id": i, "code": "network", "message": MESSAGES["network"]})
            finally:
                self.current = None
                self._cancel = None

    def _cancelled(self, i: str) -> bool:
        return bool(self._cancel and self._cancel["id"] == i)

    async def run_one(self, it: dict) -> str:
        i = it["id"]
        try:
            t = target(it)
        except ValueError:
            raise JobError("path") from None
        tok, _src = self.token_fn()
        code, h = await head_item(self.transport, it, tok)
        if code == "not_found" and (it.get("revision") or "main") != "main":
            raise JobError("revision")
        if code != "ok":
            raise JobError(code)
        hsha, hsize = linked_meta(h)
        want_sha = it.get("sha256") or hsha
        want_size = hsize or (it.get("size") if it.get("sha256") else None)
        if want_size is None and h.get("content-length") and code == "ok" and not h.get("location"):
            try:
                want_size = int(h["content-length"])
            except ValueError:
                pass
        self.current["total"] = want_size or it.get("size")

        t.parent.mkdir(parents=True, exist_ok=True)
        part = part_path(t)
        have = part.stat().st_size if part.is_file() else 0
        if want_size is not None and have > want_size:
            part.unlink()
            have = 0

        need = (want_size or it.get("size") or 0) - have + DISK_MARGIN
        free = self.disk_usage(str(t.parent)).free
        if free < need:
            raise JobError("disk", f"Not enough free disk space: needs {need / GIB:.1f} GB, {free / GIB:.1f} GB free")

        hasher = hashlib.sha256()
        if have:
            self.current["phase"] = "hashing"
            hasher = await asyncio.to_thread(_hash_file, part)

        for _attempt in range(2):
            extra = {"Range": f"bytes={have}-"} if have else None
            r = await self._get(resolve_url(it), tok, extra)
            try:
                if r.status == 416:
                    part.unlink(missing_ok=True)
                    have, hasher = 0, hashlib.sha256()
                    continue
                if r.status == 206 and have:
                    mode = "ab"
                elif r.status == 200:
                    mode, have, hasher = "wb", 0, hashlib.sha256()
                else:
                    c = classify(r.status, bool(it.get("gated")), bool(tok), r.headers.get("x-error-code"))
                    raise JobError(c if c != "ok" else "error")
                await self._stream(r, part, mode, have, hasher, i)
            finally:
                r.close()
            break
        else:
            raise JobError("error")

        if self._cancelled(i):
            if self._cancel.get("discard"):
                part.unlink(missing_ok=True)
            raise JobError("cancelled", "Cancelled")

        self.current["phase"] = "verifying"
        size = part.stat().st_size
        if want_size is not None and size != want_size:
            part.unlink(missing_ok=True)
            raise JobError("verify")
        if want_sha and hasher.hexdigest() != want_sha:
            part.unlink(missing_ok=True)
            raise JobError("verify")
        with open(part, "rb+") as f:
            os.fsync(f.fileno())
        os.replace(part, t)
        return "sha256" if want_sha else ("size" if want_size is not None else "none")

    async def _get(self, url: str, tok: str | None, extra: dict | None):
        """GET following up to MAX_HOPS redirects by hand, so Authorization stays on the Hugging Face host."""
        for _ in range(MAX_HOPS + 1):
            r = await self.transport.open("GET", url, _headers(url, tok, extra))
            if r.status in (301, 302, 303, 307, 308) and r.headers.get("location"):
                nxt = urljoin(url, r.headers["location"])
                r.close()
                if urlparse(nxt).scheme not in ("http", "https"):
                    raise JobError("error")
                url = nxt
                continue
            return r
        raise JobError("error", "Too many redirects")

    async def _stream(self, r, part: Path, mode: str, have: int, hasher, i: str):
        self.current["phase"] = "downloading"
        got, t0, last_t, last_b, rate = have, self.clock(), self.clock(), have, 0.0
        self.current["bytes"] = got
        with open(part, mode) as f:
            async for c in r.chunks(self.chunk):
                if self._cancelled(i):
                    break
                f.write(c)
                hasher.update(c)
                got += len(c)
                now = self.clock()
                dt = now - last_t
                if dt >= 0.5:
                    inst = (got - last_b) / dt
                    a = min(1.0, dt / 10.0)
                    rate = inst if rate == 0 else rate + a * (inst - rate)
                    last_t, last_b = now, got
                tot = self.current.get("total")
                self.current.update(bytes=got, rate=round(rate, 1),
                                    eta=(round((tot - got) / rate) if rate > 0 and tot else None))
                if self._cancelled(i):
                    break
            f.flush()
        del t0


def _hash_file(p: Path):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(CHUNK), b""):
            h.update(b)
    return h


# --------------------------------------------------------------------------------------------- routes

_REGISTERED = False
_STATE: dict = {"dl": None, "transport": None}


def downloader() -> Downloader:
    if _STATE["dl"] is None:
        _STATE["dl"] = Downloader(load_catalog(), transport=_STATE["transport"])
    return _STATE["dl"]


def _free_bytes() -> dict:
    out = {}
    for f in sorted(ALLOWED_FOLDERS):
        root = folder_root(f)
        p = root
        while p is not None and not p.exists() and p.parent != p:
            p = p.parent
        try:
            out[f] = shutil.disk_usage(str(p)).free if p else None
        except OSError:
            out[f] = None
    return out


PUBLIC_ITEM_KEYS = ("id", "group", "title", "repo", "revision", "path", "folder", "subdir", "saved_name", "size",
                    "sha256", "licences", "gated", "optional")


def status() -> dict:
    cat = load_catalog()
    dl = downloader()
    _tok, src = load_token()
    items = []
    for it in cat["items"]:
        row = {k: it.get(k) for k in PUBLIC_ITEM_KEYS}
        row.update(item_state(it))
        row["repo_url"] = repo_url(it["repo"])
        items.append(row)
    return {"catalog_version": cat["schema"], "groups": cat["groups"], "licences": cat["licences"],
            "sets": cat.get("sets", {}), "items": items, "installed_files": installed_files(),
            "signed_in": src is not None, "user": _STATE.get("user") if src == "saved" else None,
            "token_source": src, "free_bytes": _free_bytes(), "busy": dl.busy}


async def check_access(ids: list[str]) -> dict:
    res = await downloader().access([i for i in ids if isinstance(i, str)])
    return {"results": res, "messages": {i: MESSAGES[c] for i, c in res.items()}}


def plan_download(body: dict) -> tuple[int, dict]:
    if not isinstance(body, dict) or body.get("confirm") is not True:
        return 400, {"error": "confirm"}
    ids = body.get("ids") or []
    acc = set(body.get("accepted_licences") or [])
    cat = load_catalog()
    by = items_by_id(cat)
    refused, ok = {}, []
    for i in ids if isinstance(ids, list) else []:
        if not isinstance(i, str) or i not in by:
            refused[str(i)[:80]] = "unknown"
        elif any(k not in acc for k in by[i]["licences"]):
            refused[i] = "licence_not_confirmed"
        else:
            ok.append(i)
    return 200, {"ok": ok, "refused": refused}


async def save_token_checked(tok) -> tuple[int, dict]:
    tok = clean_token(tok)
    if not tok:
        return 400, {"error": "That doesn't look like a Hugging Face token"}
    dl = downloader()
    try:
        user = await whoami(dl.transport, tok)
    except Exception as e:  # noqa: BLE001
        log.info("modeldl: whoami failed (%s)", type(e).__name__)
        return 502, {"error": "Couldn't reach Hugging Face"}
    if not user:
        return 400, {"error": "That token was not accepted by Hugging Face"}
    await asyncio.to_thread(save_token, tok)
    _STATE["user"] = user
    dl.clear_access_cache()
    return 200, {"signed_in": True, "user": user}


def register(routes=None, transport=None) -> bool:
    """Add the /soundstage/models/* routes. With no table (ComfyUI start-up) this runs once; tests pass their own
    table and a fake transport."""
    global _REGISTERED
    if routes is None and _REGISTERED:
        return True
    from aiohttp import web
    if transport is not None or routes is not None:
        _STATE.update(dl=None, transport=transport, user=None)
    if routes is None:
        from server import PromptServer
        routes = PromptServer.instance.routes
        _REGISTERED = True

    async def _json(request):
        try:
            b = await request.json()
            return b if isinstance(b, dict) else {}
        except ValueError:
            return {}

    @routes.get("/soundstage/models/status")
    async def _status(request):
        return web.json_response(await asyncio.to_thread(status))

    @routes.post("/soundstage/models/access")
    async def _access(request):
        b = await _json(request)
        if b.get("recheck"):
            downloader().clear_access_cache()
        return web.json_response(await check_access(list(b.get("ids") or [])))

    @routes.post("/soundstage/models/download")
    async def _download(request):
        code, res = plan_download(await _json(request))
        if code != 200:
            return web.json_response(res, status=code)
        queued, skipped = downloader().enqueue(res["ok"])
        return web.json_response({"queued": queued, "skipped": skipped, "refused": res["refused"]})

    @routes.get("/soundstage/models/progress")
    async def _progress(request):
        return web.json_response(downloader().progress())

    @routes.post("/soundstage/models/cancel")
    async def _cancel(request):
        b = await _json(request)
        return web.json_response({"cancelled": downloader().cancel(b.get("id"), bool(b.get("all")), bool(b.get("discard")))})

    @routes.post("/soundstage/models/token")
    async def _token(request):
        b = await _json(request)
        code, res = await save_token_checked(b.get("token"))
        return web.json_response(res, status=code)

    @routes.post("/soundstage/models/token/remove")
    async def _token_remove(request):
        await asyncio.to_thread(remove_token)
        _STATE["user"] = None
        downloader().clear_access_cache()
        _t, src = load_token()
        return web.json_response({"signed_in": src is not None, "token_source": src})

    @routes.get("/soundstage/models/tiers")
    async def _tiers(request):
        return web.json_response({"tiers": load_catalog().get("tiers", [])})

    return True
