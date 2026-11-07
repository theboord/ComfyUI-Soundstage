"""Model downloader: get the App's model files from Hugging Face inside the App (docs/models.md).

GET  /soundstage/models/status      -> {catalog_version, groups, licences, items:[...+state, have_bytes, wrong_size?, size_note?],
                                        installed_files, signed_in, user, token_source, free_bytes, busy, done, failed}
POST /soundstage/models/access      {ids}                                  -> {results:{id:code}, messages:{id:str}}
POST /soundstage/models/download    {ids, confirm:true, accepted_licences} -> {queued, skipped, refused:{id:reason}}
GET  /soundstage/models/progress    -> {current, queue, done, failed}
POST /soundstage/models/cancel      {id?, all?, discard?}                  -> {cancelled}
POST /soundstage/models/token       {token}                                -> {signed_in, user} | 400
POST /soundstage/models/token/remove                                       -> {signed_in, token_source}
GET  /soundstage/models/tiers       -> {tiers}

Rules this module keeps:
  * The browser only sends catalog ids. Paths and URLs come from catalog.json; every target is checked to stay
    inside its ComfyUI models folder (no "..", no writing through a symlink out;
    a symlinked model file the user put at the final name counts as present).
  * The Hugging Face token never leaves the server: no route returns it, it's never logged, error messages are
    fixed strings. It is sent only to the huggingface.co host, never to the CDN a download redirects to.
    Saved at user/soundstage/hf/token (folder 700, file 600; the shared user/soundstage folder is never chmodded).
    A saved token beats HF_TOKEN and the huggingface-cli login.
  * A model counts as installed when a file with its exact name is in ANY folder ComfyUI lists for its type
    (extra_model_paths.yaml adds more); downloads go to the first one.
  * One download at a time, into <name>.part, verified and then renamed into place. verified is "sha256" (the
    catalog's or Hugging Face's X-Linked-Etag), "size" (Hugging Face's X-Linked-Size, a filled catalog size, or the
    catalog's figure within 1 %), or "unverified_size" (no size known anywhere). A response's own Content-Length is
    never trusted as a check (it only catches a cut-off transfer). Without a sha256 the file must also start like a
    safetensors file (8-byte little-endian header length, then a JSON object). A text/html (or any text/*) response,
    such as a Wi-Fi sign-in page, is refused before anything is written. A resume sends If-Range with the ETag (or
    Last-Modified) captured when the .part was started (kept in <name>.part.meta); a 200 answer starts over.
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
import secrets
import shutil
import struct
import threading
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
SIZE_SLACK = 5_000_000      # half of 0.01 GB: catalog sizes without a sha256 are rounded to 0.01 GB
CATALOG_PCT = 0.01          # a download checked only against the catalog's figure: within 1 % (or SIZE_SLACK)
MAX_ST_HEADER = 100 << 20   # a safetensors JSON header bigger than this is not a real one
CACHEABLE = ("ok", "sign_in", "licence")   # access answers kept for ACCESS_TTL; errors are always asked again

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


def folder_roots(folder: str) -> list[Path]:
    """Every folder ComfyUI lists for this type (models/<folder> plus any extra_model_paths.yaml entries)."""
    if folder not in ALLOWED_FOLDERS:
        return []
    try:
        import folder_paths
        paths = folder_paths.get_folder_paths(folder)
    except Exception:  # noqa: BLE001 - folder not registered on this ComfyUI
        return []
    out: list[Path] = []
    for p in paths or []:
        if Path(p) not in out:
            out.append(Path(p))
    return out


def folder_root(folder: str) -> Path | None:
    """The folder downloads go to: the first one ComfyUI lists."""
    roots = folder_roots(folder)
    return roots[0] if roots else None


def target(item: dict) -> Path:
    """Where the file goes. Raises ValueError if the folder isn't allowed or the path would leave it."""
    root = folder_root(item.get("folder", ""))
    if root is None:
        raise ValueError("folder not allowed")
    return _place(root, item)


def candidates(item: dict) -> list[Path]:
    """Where an installed copy may already be: the item's name under every folder of its type (download target
    first). A folder whose subdir would leave it is skipped."""
    out: list[Path] = []
    for root in folder_roots(item.get("folder", "")):
        try:
            c = _place(root, item)
        except ValueError:
            continue
        if c not in out:
            out.append(c)
    return out


def _place(root: Path, item: dict) -> Path:
    sub, name = item.get("subdir", "") or "", item.get("saved_name", "")
    if not _rel_ok(sub, allow_empty=True) or not _rel_ok(name) or "/" in name:
        raise ValueError("path escapes the models folder")
    rr = root.resolve()
    t = (root / sub / name) if sub else (root / name)
    # Only the write path is checked: the directory we write into (resolved, so a symlinked subdir pointing out of
    # the folder is refused) and, in the job, the .part file. A file already at the final name may be a symlink the
    # user made on purpose (models kept on a shared or network volume): it counts as present and is size-checked
    # through the link, so it is not resolved here.
    parent = t.parent.resolve()
    try:
        parent.relative_to(rr)
    except ValueError:
        raise ValueError("path escapes the models folder") from None
    return parent / t.name


def part_path(t: Path) -> Path:
    return t.with_name(t.name + ".part")


def meta_path(part: Path) -> Path:
    """Beside the .part: the validator (ETag / Last-Modified) of the response that started it, for If-Range."""
    return part.with_name(part.name + ".meta")


def read_meta(part: Path) -> str | None:
    m = meta_path(part)
    try:
        if m.is_symlink():
            return None
        v = json.loads(m.read_text()).get("validator")
        return v if isinstance(v, str) and v and len(v) < 512 and "\n" not in v and "\r" not in v else None
    except Exception:  # noqa: BLE001 - missing / unreadable: no validator
        return None


def write_meta(part: Path, validator: str | None) -> None:
    m = meta_path(part)
    try:
        if m.is_symlink() or m.exists():
            m.unlink()
        if validator:
            fd = os.open(m, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o644)
            with os.fdopen(fd, "w") as f:
                f.write(json.dumps({"validator": validator}))
    except OSError:
        log.info("modeldl: could not write the resume note")


def drop_part(part: Path) -> None:
    part.unlink(missing_ok=True)      # unlink never follows a symlink
    meta_path(part).unlink(missing_ok=True)


def response_validator(headers: dict) -> str | None:
    """A strong ETag, else Last-Modified: what If-Range may carry (a weak ETag may not)."""
    et = (headers.get("etag") or "").strip()
    if et and not et.startswith("W/") and "\n" not in et and len(et) < 512:
        return et
    lm = (headers.get("last-modified") or "").strip()
    return lm if lm and "\n" not in lm and len(lm) < 128 else None


def safetensors_ok(p: Path) -> bool:
    """The file starts like a safetensors file: 8 bytes little-endian header length, then that many bytes of JSON
    object. Catches an HTML page or a truncated/garbage body saved under a model name."""
    try:
        size = p.stat().st_size
        with open(p, "rb") as f:
            head = f.read(8)
            if len(head) != 8:
                return False
            n = struct.unpack("<Q", head)[0]
            if n < 2 or n > MAX_ST_HEADER or n > size - 8:
                return False
            raw = f.read(n)
        j = json.loads(raw.decode("utf-8"))
        return isinstance(j, dict)
    except (OSError, ValueError, UnicodeDecodeError):
        return False


def size_within_pct(actual: int, approx: int, pct: float = CATALOG_PCT) -> bool:
    """The download check against the catalog's figure when nothing exact is known: within pct (1 %), and never
    tighter than SIZE_SLACK, since catalog sizes are rounded to 0.01 GB (off by up to 5 MB on any file)."""
    return abs(actual - approx) <= max(approx * pct, SIZE_SLACK)


def size_close(actual: int, approx: int) -> bool:
    """A catalog size without a sha256 is the rounded GB figure (to 0.01 GB): accept within half that rounding,
    and never more than 2 % (so a small test file can't pass a 2x size)."""
    return abs(actual - approx) <= min(SIZE_SLACK, approx // 50)


def verified_path() -> Path:
    import folder_paths
    return Path(folder_paths.get_user_directory()) / "soundstage" / "models_verified.json"


def _verified_all() -> dict:
    try:
        d = json.loads(verified_path().read_text())
        return d if isinstance(d, dict) else {}
    except Exception:  # noqa: BLE001 - missing / unreadable: nothing recorded
        return {}


def _rel(item: dict) -> str:
    sub = item.get("subdir", "") or ""
    return f"{sub}/{item.get('saved_name', '')}" if sub else item.get("saved_name", "")


def verified_size(item: dict) -> int | None:
    """The exact size recorded when this App last downloaded and verified the file (None if it never did)."""
    e = _verified_all().get(item.get("id", ""))
    if not isinstance(e, dict) or e.get("folder") != item.get("folder") or e.get("name") != _rel(item):
        return None
    n = e.get("size")
    return n if isinstance(n, int) and not isinstance(n, bool) and n > 0 else None


def record_verified(item: dict, size: int, sha: str | None) -> None:
    """Remember the exact size of a file that passed verification, so status can judge it exactly later."""
    try:
        p = verified_path()
        p.parent.mkdir(parents=True, exist_ok=True)
        d = _verified_all()
        d[item["id"]] = {"folder": item.get("folder"), "name": _rel(item), "size": int(size),
                         **({"sha256": sha} if sha else {})}
        tmp = p.with_name(p.name + ".tmp")
        tmp.write_text(json.dumps(d, indent=1, sort_keys=True))
        os.replace(tmp, p)
    except Exception:  # noqa: BLE001 - the file is in place either way; status falls back to the soft note
        log.warning("soundstage models: could not record the verified size")


def exact_size(item: dict) -> int | None:
    """An exact size to judge an installed file by: a catalog size once its sha256 is filled (the fill step writes
    lfs.size), else the size recorded when this App verified the download. The catalog's rounded GB figure is never
    exact."""
    if item.get("sha256") and isinstance(item.get("size"), int):
        return item["size"]
    return verified_size(item)


def item_state(item: dict) -> dict:
    """installed / partial / missing (no hashing: status must be quick). other_build is worked out in the browser.
    A file at the target name (or a symlink to one) is installed unless an exact size is known and differs: then it
    is reported with wrong_size so it can be downloaded again. The catalog's rounded GB figure only ever adds a soft
    size_note, never wrong_size, so a good file is never re-downloaded because of a rounding error."""
    exact = exact_size(item)
    wrong = False
    # every folder ComfyUI lists for this type: an exact-name file in any of them is the model
    for c in candidates(item):
        if not c.is_file():
            continue
        n = c.stat().st_size
        if exact is None or n == exact:
            out = {"state": "installed", "have_bytes": n}
            approx = item.get("size")
            if exact is None and isinstance(approx, int) and not size_close(n, approx):
                out["size_note"] = True
            return out
        wrong = True
    try:
        t = target(item)
    except ValueError:
        return {"state": "missing", "have_bytes": 0, **({"wrong_size": True} if wrong else {})}
    p = part_path(t)
    # a symlinked .part is never trusted (the job deletes it rather than write through it)
    out = ({"state": "partial", "have_bytes": p.stat().st_size} if p.is_file() and not p.is_symlink()
           else {"state": "missing", "have_bytes": 0})
    if wrong:
        out["wrong_size"] = True
    return out


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
    """user/soundstage/hf/token: its own folder (700), so the shared user/soundstage folder keeps its permissions."""
    import folder_paths
    return Path(folder_paths.get_user_directory()) / "soundstage" / "hf" / "token"


def legacy_token_path() -> Path:
    """Where an earlier build of this branch saved it; still read, and removed on the next save or remove."""
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
    d = p.parent
    d.parent.mkdir(parents=True, exist_ok=True)       # user/soundstage: shared, default permissions, never chmodded
    try:
        d.mkdir(mode=0o700)
    except FileExistsError:
        pass
    if d.is_symlink() or not d.is_dir():
        raise ValueError("The token folder is not a plain folder")
    os.chmod(d, 0o700)                                 # hf/ is ours alone
    # a fresh, unpredictable temp name created exclusively at 600 (never an existing file or a planted symlink)
    tmp = d / f".token.{secrets.token_hex(8)}.tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        try:
            os.write(fd, tok.encode())
            os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(tmp, p)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    legacy_token_path().unlink(missing_ok=True)


def remove_token() -> bool:
    gone = False
    for p in (token_path(), legacy_token_path()):
        try:
            p.unlink()
            gone = True
        except FileNotFoundError:
            pass
    return gone


def load_token(skip_saved: bool = False) -> tuple[str | None, str | None]:
    """(token, source): the saved file (beats everything), then HF_TOKEN, then the huggingface-cli login file (read
    only). skip_saved: what would be used without the saved one (the panel's "Remove token goes back to ..." note)."""
    if not skip_saved:
        for p in (token_path(), legacy_token_path()):
            try:
                t = clean_token(p.read_text())
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

    async def close(self):
        if self._session is not None and not self._session.closed:
            await self._session.close()
        self._session = None


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
    "bad_token": "Your Hugging Face token was refused: replace it above",
    "not_found": "Hugging Face can't find this file",
    "error": "Couldn't reach Hugging Face",
    "network": "The connection dropped. Click Download again to resume.",
    "disk": "Not enough free disk space",
    "verify": "The downloaded file didn't match; it was deleted",
    "not_model": "Got a web page instead of the model file (a Wi-Fi sign-in page or a proxy?). Nothing was saved",
    "path": "That file would go outside the models folder",
    "revision": "The pinned version of this file is gone from Hugging Face",
}

_NOT_FOUND_CODES = ("RepoNotFound", "EntryNotFound", "RevisionNotFound")


def classify(status: int, gated: bool, has_token: bool, error_code: str | None = None) -> str:
    ec = (error_code or "").strip()
    if ec == "GatedRepo":
        return "licence" if has_token else "sign_in"
    if status in (200, 301, 302, 303, 307, 308):
        return "ok"
    if status == 401:
        if not has_token:
            return "sign_in"
        # with a token: Hugging Face says the file isn't there (or is private), else it refused the token itself
        return "not_found" if ec in _NOT_FOUND_CODES else "bad_token"
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


def _is_text(headers: dict) -> bool:
    """A web page or other text: never a model file (a captive portal, a proxy's error page)."""
    ct = (headers.get("content-type") or "").split(";")[0].strip().lower()
    return ct.startswith("text/") or "html" in ct


def _int(v) -> int | None:
    try:
        n = int(v)
        return n if n >= 0 else None
    except (TypeError, ValueError):
        return None


# --------------------------------------------------------------------------------------------- downloader

class JobError(Exception):
    def __init__(self, code: str, message: str | None = None):
        super().__init__(code)
        self.code, self.message = code, message or MESSAGES.get(code, code)


class Downloader:
    def __init__(self, catalog: dict, transport=None, token_fn=load_token, disk_usage=shutil.disk_usage,
                 chunk: int = CHUNK, clock=time.monotonic):
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
        self.set_catalog(catalog)

    def set_catalog(self, catalog: dict) -> None:
        """Use a changed catalog. Queued ids the new one doesn't have are dropped when their turn comes; the file
        running now keeps the item it started with."""
        self.cat = catalog
        self.items = items_by_id(catalog)
        self._access.clear()

    # ---- access: one HEAD per file, cached per (file, token fingerprint) for a minute; only clear answers are kept
    def clear_access_cache(self):
        self._access.clear()

    @staticmethod
    def _access_key(it: dict, fp: str) -> tuple:
        return (it["repo"], it.get("revision") or "main", it["path"], fp)

    async def access(self, ids: list[str]) -> dict:
        tok, _src = self.token_fn()
        fp = fingerprint(tok)
        now = self.clock()
        out, todo = {}, []
        for i in dict.fromkeys(ids):
            it = self.items.get(i)
            if not it:
                continue
            hit = self._access.get(self._access_key(it, fp))
            if hit and now - hit[1] < ACCESS_TTL:
                out[i] = hit[0]
            else:
                todo.append(it)
        res = await asyncio.gather(*(head_item(self.transport, it, tok) for it in todo))
        for it, (code, _h) in zip(todo, res):
            out[it["id"]] = code
            key = self._access_key(it, fp)
            if code in CACHEABLE:
                self._access[key] = (code, now)
            else:
                self._access.pop(key, None)        # an error (or a refused token) is asked again next time
        return {i: out[i] for i in dict.fromkeys(ids) if i in out}

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
        drop = list(self.queue) if all else ([id] if id and id in self.queue else [])
        for i in drop:
            self.queue.remove(i)
            out.append(i)
            if discard:
                self._discard(i)
        if self.current and (all or id == self.current["id"]):
            self._cancel = {"id": self.current["id"], "discard": bool(discard)}
            out.append(self.current["id"])
        return out

    def _discard(self, i: str) -> None:
        """Delete a queued (not running) file's .part and its resume note."""
        it = self.items.get(i)
        if not it:
            return
        try:
            drop_part(part_path(target(it)))
        except (ValueError, OSError):
            pass

    def progress(self) -> dict:
        c = None
        if self.current:
            c = {k: self.current.get(k) for k in ("id", "bytes", "total", "rate", "eta", "phase")}
        return {"current": c, "queue": list(self.queue), "done": list(self.done), "failed": list(self.failed)}

    async def _worker(self):
        while self.queue:
            i = self.queue.popleft()
            it = self.items.get(i)
            if it is None:                 # the catalog changed while it waited
                continue
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

    def _stop_if_cancelled(self, i: str, part: Path | None) -> None:
        if not self._cancelled(i):
            return
        if part is not None and self._cancel.get("discard"):
            drop_part(part)
        raise JobError("cancelled", "Cancelled")

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
        # Exact sizes only from sources we trust: Hugging Face's X-Linked-Size, or a catalog size filled with its
        # sha256. A response's own Content-Length is never a check (a portal page has one too).
        exact = hsize or (it.get("size") if it.get("sha256") else None)
        approx = None if exact is not None else it.get("size")   # the catalog's figure: within 1 % (at least 5 MB)
        self.current["total"] = exact or approx

        t.parent.mkdir(parents=True, exist_ok=True)
        part = part_path(t)
        if part.is_symlink():
            part.unlink()
        have = part.stat().st_size if part.is_file() else 0
        if exact is not None and have > exact:
            drop_part(part)
            have = 0
        validator = read_meta(part) if have else None
        complete = exact is not None and have == exact
        if have and not complete and not validator and not want_sha:
            # nothing ties this .part to what the server sends now, and no sha256 would catch a mix: start over
            drop_part(part)
            have = 0

        need = (exact or approx or 0) - have + DISK_MARGIN
        free = self.disk_usage(str(t.parent)).free
        if free < need:
            raise JobError("disk", f"Not enough free disk space: needs {need / GIB:.1f} GB, {free / GIB:.1f} GB free")
        self._stop_if_cancelled(i, part)

        hasher = hashlib.sha256()
        if have:
            self.current["phase"] = "hashing"
            hasher = await asyncio.to_thread(_hash_file, part)
        # cancelled while the part was being hashed: stop here, before any GET
        self._stop_if_cancelled(i, part)

        def restart():
            nonlocal have, hasher, validator
            drop_part(part)
            have, hasher, validator = 0, hashlib.sha256(), None

        # A .part that is already whole (a cancel after the last chunk, or a crash before the rename): finish it.
        for _attempt in range(3):
            if complete:
                break
            extra = None
            if have:
                extra = {"Range": f"bytes={have}-"}
                if validator:
                    extra["If-Range"] = validator     # "only if it's still the same file", else the whole file (200)
            r = await self._get(resolve_url(it), tok, extra)
            try:
                if r.status in (200, 206) and _is_text(r.headers):
                    raise JobError("not_model")      # before anything is written: the .part is left as it was
                cr = _content_range(r.headers.get("content-range"))
                if r.status == 416:
                    total = cr[2] if cr else None
                    if have and total is not None and total == have and (exact is None or exact == have):
                        complete = True             # every byte is here; verification below still decides
                        break
                    restart()
                    continue
                if r.status == 206 and have:
                    rv = response_validator(r.headers)
                    if not cr or cr[0] != have or (validator and rv and rv != validator):
                        # a range we didn't ask for, or another version of the file: appending would corrupt it
                        restart()
                        continue
                    mode = "ab"
                    shown = cr[2]
                elif r.status == 200:
                    # a fresh start, or the server ignored If-Range / Range (the file changed): start over cleanly
                    mode, have, hasher = "wb", 0, hashlib.sha256()
                    validator = response_validator(r.headers)
                    write_meta(part, validator)
                    shown = _int(r.headers.get("content-length"))
                else:
                    c = classify(r.status, bool(it.get("gated")), bool(tok), r.headers.get("x-error-code"))
                    raise JobError(c if c != "ok" else "error")
                self.current["total"] = exact or approx or shown    # shown: for the progress bar only
                wrote = await self._stream(r, part, mode, have, hasher, i)
                declared = _int(r.headers.get("content-length"))
                if declared is not None and wrote < declared and not self._cancelled(i):
                    raise JobError("network")       # cut off: the .part is kept and resumes next time
            finally:
                r.close()
            break
        else:
            raise JobError("error")

        self._stop_if_cancelled(i, part)

        self.current["phase"] = "verifying"
        size = part.stat().st_size
        if exact is not None and size != exact:
            drop_part(part)
            raise JobError("verify")
        if exact is None and approx is not None and not size_within_pct(size, approx):
            drop_part(part)
            raise JobError("verify")
        if want_sha:
            if hasher.hexdigest() != want_sha:
                drop_part(part)
                raise JobError("verify")
            level = "sha256"
        else:
            level = "size" if (exact is not None or approx is not None) else "unverified_size"
            if not await asyncio.to_thread(safetensors_ok, part):
                drop_part(part)
                raise JobError("verify")
        with open(part, "rb+") as f:
            os.fsync(f.fileno())
        os.replace(part, t)
        meta_path(part).unlink(missing_ok=True)
        record_verified(it, size, want_sha)
        return level

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

    async def _stream(self, r, part: Path, mode: str, have: int, hasher, i: str) -> int:
        """Write the body; returns the bytes this response delivered."""
        self.current["phase"] = "downloading"
        got, last_t, last_b, rate = have, self.clock(), have, 0.0
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
        return got - have


def _content_range(v) -> tuple[int | None, int | None, int | None] | None:
    """'bytes 5-9/10' -> (5, 9, 10); 'bytes */10' -> (None, None, 10); anything else -> None."""
    m = re.match(r"^\s*bytes\s+(?:(\d+)-(\d+)|\*)/(\d+|\*)\s*$", v or "")
    if not m:
        return None
    a, b, tot = m.group(1), m.group(2), m.group(3)
    return (int(a) if a else None, int(b) if b else None, int(tot) if tot != "*" else None)


def _hash_file(p: Path):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(CHUNK), b""):
            h.update(b)
    return h


# --------------------------------------------------------------------------------------------- routes

_REGISTERED = False
_STATE: dict = {"dl": None, "transport": None}
_DL_LOCK = threading.Lock()      # status() runs in a worker thread; /download on the loop: one Downloader only


def downloader() -> Downloader:
    """The one Downloader (made at register time; made here under a lock if that failed). It picks up a changed
    catalog.json; an invalid one is refused and the last good one kept."""
    with _DL_LOCK:
        dl = _STATE["dl"]
        try:
            cat = load_catalog()
        except (OSError, ValueError):
            if dl is None:
                raise
            log.warning("soundstage models: catalog.json is invalid; keeping the last good one")
            return dl
        if dl is None:
            dl = _STATE["dl"] = Downloader(cat, transport=_STATE["transport"])
        elif dl.cat is not cat:
            dl.set_catalog(cat)
        return dl


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
    dl = downloader()
    cat = dl.cat
    _tok, src = load_token()
    _t2, fallback = load_token(skip_saved=True)
    items = []
    for it in cat["items"]:
        row = {k: it.get(k) for k in PUBLIC_ITEM_KEYS}
        row.update(item_state(it))
        row["repo_url"] = repo_url(it["repo"])
        items.append(row)
    return {"catalog_version": cat["schema"], "groups": cat["groups"], "licences": cat["licences"],
            "sets": cat.get("sets", {}), "items": items, "installed_files": installed_files(),
            "signed_in": src is not None, "user": _STATE.get("user") if src == "saved" else None,
            # token_source: the one in use (saved beats HF_TOKEN beats the huggingface-cli login);
            # token_fallback: what Remove token goes back to. Names only, never a value.
            "token_source": src, "token_fallback": fallback, "free_bytes": _free_bytes(), "busy": dl.busy,
            # this session's finished and failed jobs, so a job that fails before the panel's first progress poll
            # (a disk refusal, sign-in) and earlier failures on a reopened panel still show on their rows
            "done": list(dl.done), "failed": list(dl.failed)}


async def check_access(ids: list[str]) -> dict:
    res = await downloader().access([i for i in ids if isinstance(i, str)])
    return {"results": res, "messages": {i: MESSAGES[c] for i, c in res.items()}}


def plan_download(body: dict) -> tuple[int, dict]:
    if not isinstance(body, dict) or body.get("confirm") is not True:
        return 400, {"error": "confirm"}
    ids = body.get("ids") or []
    acc = set(body.get("accepted_licences") or [])
    by = downloader().items
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
    return 200, {"signed_in": True, "user": user, "token_source": "saved"}


def register(routes=None, transport=None) -> bool:
    """Add the /soundstage/models/* routes. With no table (ComfyUI start-up) this runs once; tests pass their own
    table and a fake transport. The Downloader is made here, so two first requests can't each make one."""
    global _REGISTERED
    if routes is None and _REGISTERED:
        return True
    from aiohttp import web
    if transport is not None or routes is not None:
        with _DL_LOCK:
            _STATE.update(dl=None, transport=transport, user=None)
    if routes is None:
        from server import PromptServer
        routes = PromptServer.instance.routes
        _REGISTERED = True
    try:
        downloader()
    except (OSError, ValueError):
        log.warning("soundstage models: catalog.json could not be read; the Models panel will say so")

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
        return web.json_response({"tiers": downloader().cat.get("tiers", [])})

    return True
