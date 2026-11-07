"""A fake Hugging Face for the model-downloader tests: no sockets, no network. Imported by tests/test_modeldl*.py."""
import asyncio
import hashlib
import sys
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

TOKEN = "hf_TESTtokenVALUE123456789"   # invented; asserted never to leak
HF = "https://huggingface.co"


def stub_folder_paths(monkeypatch, tmp_path):
    """folder_paths with every allowed models folder under tmp/models and the user dir at tmp/user."""
    fp = types.ModuleType("folder_paths")
    models = tmp_path / "models"
    for f in ("diffusion_models", "text_encoders", "vae", "loras", "latent_upscale_models", "checkpoints",
              "background_removal"):
        (models / f).mkdir(parents=True, exist_ok=True)
    fp.get_folder_paths = lambda f: [str(models / f)]

    def names(f):
        base = models / f
        return sorted(str(p.relative_to(base)).replace("\\", "/") for p in base.rglob("*") if p.is_file()
                      and not p.name.endswith(".part"))
    fp.get_filename_list = names
    (tmp_path / "user").mkdir(exist_ok=True)
    fp.get_user_directory = lambda: str(tmp_path / "user")
    monkeypatch.setitem(sys.modules, "folder_paths", fp)
    monkeypatch.delenv("HF_TOKEN", raising=False)
    monkeypatch.delenv("SOUNDSTAGE_HF_ENDPOINT", raising=False)
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    return models


class FakeResp:
    def __init__(self, status, headers=None, body=b"", chunk_hook=None):
        self.status = status
        self.headers = {k.lower(): v for k, v in (headers or {}).items()}
        self.body = body
        self.chunk_hook = chunk_hook
        self.closed = False

    async def chunks(self, n):
        for i in range(0, len(self.body), n):
            if self.chunk_hook:
                await self.chunk_hook(i)
            await asyncio.sleep(0)
            yield self.body[i:i + n]

    async def read(self, limit=1 << 20):
        return self.body[:limit]

    def close(self):
        self.closed = True


class FakeHF:
    """Serves files as  HEAD/GET {HF}/{repo}/resolve/{rev}/{path}.

    files: {(repo, path): bytes}. Options per instance:
      head_status / gated_repos / missing: shape the HEAD answer;
      redirect_cdn: GET on huggingface.co answers 302 to https://cdn.example/<path> (the CDN serves the bytes);
      range_mode: "206" (honour Range), "200" (ignore Range), "416" (refuse a Range once);
      etag: send X-Linked-Etag / X-Linked-Size on HEAD; corrupt: serve different bytes on GET.
    """

    def __init__(self, files, **kw):
        self.files = dict(files)
        self.calls = []            # (method, url, headers)
        self.head_status = kw.get("head_status", {})   # {repo: status}
        self.redirect_cdn = kw.get("redirect_cdn", False)
        self.range_mode = kw.get("range_mode", "206")
        self.etag = kw.get("etag", True)
        self.corrupt = kw.get("corrupt", False)
        self.chunk_hook = kw.get("chunk_hook")
        self.whoami = kw.get("whoami", {TOKEN: "jane-doe"})
        self.active = 0
        self.max_active = 0
        self._refused_once = False

    def _find(self, url):
        rest = url.split("/resolve/", 1)
        if len(rest) != 2:
            return None, None
        repo = rest[0].replace(HF + "/", "")
        path = rest[1].split("/", 1)[1]
        return repo, path

    async def open(self, method, url, headers, timeout=None):
        self.calls.append((method, url, dict(headers)))
        if url.endswith("/api/whoami-v2"):
            tok = (headers.get("Authorization") or "").replace("Bearer ", "")
            if tok in self.whoami:
                return FakeResp(200, body=('{"name": "%s"}' % self.whoami[tok]).encode())
            return FakeResp(401)
        if url.startswith("https://cdn.example/"):
            key = url[len("https://cdn.example/"):]
            repo, path = key.split("|", 1)
            return self._serve(repo, path, headers)
        repo, path = self._find(url)
        if repo in self.head_status and self.head_status[repo] != 200:
            return FakeResp(self.head_status[repo])
        if (repo, path) not in self.files:
            return FakeResp(404, {"X-Error-Code": "EntryNotFound"})
        data = self.files[(repo, path)]
        if method == "HEAD":
            h = {"Location": "https://cdn.example/x"} if self.redirect_cdn else {}
            if self.etag:
                h.update({"X-Linked-Etag": '"%s"' % hashlib.sha256(data).hexdigest(), "X-Linked-Size": str(len(data))})
            return FakeResp(302 if self.redirect_cdn else 200, h)
        if self.redirect_cdn:
            return FakeResp(302, {"Location": f"https://cdn.example/{repo}|{path}"})
        return self._serve(repo, path, headers)

    def _serve(self, repo, path, headers):
        data = self.files[(repo, path)]
        if self.corrupt:
            data = b"X" + data[1:]
        rng = headers.get("Range")
        start = int(rng.split("=")[1].rstrip("-")) if rng else 0
        self.active += 1
        self.max_active = max(self.max_active, self.active)
        fake = self

        class R(FakeResp):
            def close(self_inner):
                if not self_inner.closed:
                    fake.active -= 1
                super().close()
        if rng and self.range_mode == "416" and not self._refused_once:
            self._refused_once = True
            return R(416)
        if rng and self.range_mode == "206":
            return R(206, body=data[start:], chunk_hook=self.chunk_hook)
        return R(200, body=data, chunk_hook=self.chunk_hook)


def mini_catalog(items, licences=None):
    lic = licences or {"apache-2.0": {"name": "Apache-2.0", "revenue_limit_usd": None, "geo_excluded": [],
                                      "url": "https://example.org/apache"}}
    full = []
    for it in items:
        d = {"group": "g", "revision": "main", "subdir": "", "sha256": None, "licences": ["apache-2.0"],
             "gated": False, "optional": False, "title": it["id"], "size": None}
        d.update(it)
        d.setdefault("saved_name", d["path"].split("/")[-1])
        full.append(d)
    return {"schema": 1, "groups": [{"id": "g", "title": "G"}], "licences": lic, "items": full, "sets": {}, "tiers": []}
