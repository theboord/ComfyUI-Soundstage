#!/usr/bin/env python3
"""Build the try-it demo (the claude.ai Artifact) from the latest committed web/ plus the demo shell, scenes and media.

    python3 tools/tryit/build_tryit.py                 # build from origin/main into the default staging folder
    python3 tools/tryit/build_tryit.py --ref HEAD      # any commit-ish; --web DIR builds from a folder instead
    python3 tools/tryit/build_tryit.py --mark-published  # after a successful publish: remember what is live now

Staging layout (what the Artifact serves):
  index.html, demo.mjs                 the demo shell (tools/tryit/shell)
  scripts/{app,api,glbshim}.js         the stand-in ComfyUI (tools/tryit/shell/scripts)
  extensions/soundstage/...            the real App code (web/ at the ref); GLBs ship as .glb.b64.txt and the DCC
                                       builder scripts as .py.txt (the host serves web media types only)
  r/scenes/<key>.json                  demo scenes (tools/tryit/scenes)
  r/<media>, refs/<img>                renders and clips the scenes and the tour point at (the media cache)

The media cache (default ~/OpenHiggsfieldContest/tryit_media) holds every published render. tools/tryit/media.json lists
the clips encoded into it from share/ (960 px, crf 28, AAC 96k); missing or stale ones are re-encoded here.

Outputs next to the staging folder:
  publish_files.json      {published path: staging file | null}: only what changed since the last publish, plus
                          null for paths that are live but no longer built. Pass it as the Artifact `files` map with
                          file_path = <staging>/index.html. Split into publish_files_<n>.json when one publish would
                          go over 255 files or 64 MB.
"""
import argparse, base64, hashlib, json, os, re, shutil, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
HOME = os.path.expanduser("~")
DEFAULT_MEDIA = os.path.join(HOME, "OpenHiggsfieldContest", "tryit_media")
DEFAULT_OUT = os.path.join(tempfile.gettempdir(), "soundstage_tryit", "staging")
ARTIFACT = "https://claude.ai/artifact/GwtC3yFZtGCsTsiPGbvnAq"
PUBLISHED = os.path.join(HERE, "published.json")       # {path: sha256} of what is live (written by --mark-published)
MAX_FILES, MAX_BYTES, MAX_FILE = 255, 64_000_000, 16_000_000
# Never shipped, whatever a manifest says.
PRIVATE = re.compile(r"soundstage_private|private_mike_test|24[ _-]?hour", re.I)
# web/ files the demo doesn't load (standalone previews, ComfyUI-only Python, caches).
SKIP_DIRS = {"__pycache__", "demo"}
SKIP_FILES = re.compile(r"(\.html|\.DS_Store|\.pyc)$|^tryit/(tryit\.mjs|steps\.mjs|.*\.jpg)$")


def sh(*a, **k):
    return subprocess.run(a, check=True, capture_output=True, text=True, **k).stdout


def sha(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def ascii_html(h):
    """Non-ASCII as CSS escapes inside <style> and HTML entities elsewhere (immune to a missing charset)."""
    parts = re.split(r"(<style>.*?</style>)", h, flags=re.S)
    return "".join("".join(c if ord(c) < 128 else (f"\\{ord(c):X} " if p.startswith("<style>") else f"&#{ord(c)};") for c in p) for p in parts)


def encode(src, dst, kind, vf=None):
    """The r/ recipe: videos 960 px wide, H.264 crf 28, AAC 96k, faststart; stills 1280 px JPEG (frame0: a clip's first frame)."""
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    pre = f"{vf}," if vf else ""
    if kind in ("still", "frame0"):
        cmd = ["ffmpeg", "-v", "error", "-y", "-i", src, "-frames:v", "1", "-vf", f"{pre}scale='min(1280,iw)':-2", "-q:v", "4", dst]
    else:
        cmd = ["ffmpeg", "-v", "error", "-y", "-i", src, "-vf", f"{pre}scale='min(960,iw)':-2", "-c:v", "libx264", "-crf", "28",
               "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", dst]
    subprocess.run(cmd, check=True)


def media_refs(scene):
    """Every r/ file a scene JSON points at: its renders (PNG stills ship as JPEG), chosen frames, the cut, extras."""
    out = set()
    def add(name):
        if name:
            out.add(re.sub(r"\.png$", ".jpg", str(name), flags=re.I))
    for kinds in (scene.get("props", {}).get("ss_renders") or {}).values():
        for f in (kinds or {}).values():
            if isinstance(f, dict):
                add(f.get("filename"))
    for c in ((scene.get("props", {}).get("ss_chosen") or {}).get("chosen") or {}).values():
        add(((c or {}).get("file") or {}).get("filename"))
    add(scene.get("cut"))
    for files in (scene.get("candidates") or {}).values():   # Frame variations the replay cycles through
        for f in files or []:
            add((f or {}).get("filename"))
    for x in scene.get("media") or []:     # tour clips and stills shown with the scene
        add(x.get("file") if isinstance(x, dict) else x)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--ref", default="origin/main", help="commit to build web/ from (default origin/main, fetched first)")
    ap.add_argument("--web", help="build from this web/ folder instead of a commit")
    ap.add_argument("--out", default=DEFAULT_OUT, help=f"staging folder (default {DEFAULT_OUT})")
    ap.add_argument("--media", default=DEFAULT_MEDIA, help=f"media cache (default {DEFAULT_MEDIA})")
    ap.add_argument("--mark-published", action="store_true", help="record the staging folder as what is live now")
    a = ap.parse_args()
    out = os.path.abspath(a.out)

    if a.mark_published:
        man = json.load(open(os.path.join(out, "..", "manifest.json")))
        json.dump(man, open(PUBLISHED, "w"), indent=0, sort_keys=True)
        print(f"recorded {len(man)} published files in {os.path.relpath(PUBLISHED, REPO)}")
        return

    # ---------- web/ at a commit (a throwaway worktree, so half-finished work in the shared tree never ships)
    wt = None
    if a.web:
        web, rev = os.path.abspath(a.web), "working tree"
    else:
        if a.ref.startswith("origin/"):
            subprocess.run(["git", "-C", REPO, "fetch", "-q", "origin"], check=False)
        rev = sh("git", "-C", REPO, "rev-parse", "--short", a.ref).strip()
        wt = tempfile.mkdtemp(prefix="ss_tryit_wt_")
        sh("git", "-C", REPO, "worktree", "add", "-q", "--detach", wt, a.ref)
        web = os.path.join(wt, "web")
    try:
        build(web, rev, out, a.media)
    finally:
        if wt:
            subprocess.run(["git", "-C", REPO, "worktree", "remove", "--force", wt], check=False)


def build(web, rev, out, media):
    shutil.rmtree(out, ignore_errors=True)
    os.makedirs(out)
    ext = os.path.join(out, "extensions", "soundstage")

    # ---------- the App code
    for root, dirs, files in os.walk(web):
        dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS)
        for f in sorted(files):
            src = os.path.join(root, f)
            rel = os.path.relpath(src, web).replace(os.sep, "/")
            if SKIP_FILES.search(rel) or PRIVATE.search(rel):
                continue
            dst = os.path.join(ext, rel)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            if f.endswith(".glb"):
                open(dst + ".b64.txt", "w").write(base64.b64encode(open(src, "rb").read()).decode())
            elif f.endswith(".py"):
                shutil.copy(src, dst + ".txt")
            else:
                shutil.copy(src, dst)

    # ---------- the shell and the stand-in ComfyUI
    shell = os.path.join(HERE, "shell")
    for root, _, files in os.walk(shell):
        for f in files:
            src = os.path.join(root, f)
            rel = os.path.relpath(src, shell)
            dst = os.path.join(out, rel)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            if rel == "index.html":
                open(dst, "w").write(ascii_html(open(src, encoding="utf-8").read()))
            else:
                shutil.copy(src, dst)
    open(os.path.join(out, "build.json"), "w").write(json.dumps({"rev": rev}))
    # Local test page beside the staging folder: the document skeleton the Artifact host adds, and a <base> into staging/.
    page = open(os.path.join(out, "index.html")).read()
    open(os.path.join(os.path.dirname(out), "local.html"), "w").write(
        '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
        f'<base href="{os.path.basename(out)}/"></head><body>\n{page}\n</body></html>')

    # ---------- media: re-encode stale clips from share/ into the cache
    manifest = json.load(open(os.path.join(HERE, "media.json")))
    for m in manifest.get("encode", []):
        src = os.path.expanduser(m["src"])
        if PRIVATE.search(src):
            sys.exit(f"refusing private source {src}")
        dst = os.path.join(media, "r", m["out"])
        if not os.path.exists(src):
            print("  missing source", src)
            continue
        if not os.path.exists(dst) or os.path.getmtime(dst) < os.path.getmtime(src):
            print("  encode", m["out"])
            encode(src, dst, m.get("kind") or ("still" if re.search(r"\.(jpe?g|png)$", m["out"], re.I) else "video"), m.get("vf"))

    # ---------- scenes + the media they reference
    need = set(manifest.get("always", []))
    sdir = os.path.join(HERE, "scenes")
    os.makedirs(os.path.join(out, "r", "scenes"), exist_ok=True)
    for f in sorted(os.listdir(sdir)):
        if f.endswith(".json"):
            scene = json.load(open(os.path.join(sdir, f)))
            need |= {f"r/{x}" for x in media_refs(scene)}
            shutil.copy(os.path.join(sdir, f), os.path.join(out, "r", "scenes", f))
    tour = os.path.join(HERE, "shell", "tour.json")
    if os.path.exists(tour):
        for s in json.load(open(tour)).get("steps", []):
            for c in s.get("clips") or []:
                need.add(f"r/{c['file']}")
    missing = []
    for rel in sorted(need):
        if PRIVATE.search(rel):
            sys.exit(f"refusing private media {rel}")
        src = os.path.join(media, rel)
        if not os.path.exists(src):
            missing.append(rel)
            continue
        dst = os.path.join(out, rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy(src, dst)
    if missing:
        print("  MISSING media (not in the cache):", *missing, sep="\n    ")

    # ---------- manifest, and what to publish
    files = sorted(os.path.relpath(os.path.join(r, f), out).replace(os.sep, "/") for r, _, fs in os.walk(out) for f in fs)
    files = [f for f in files if f != "build.json"]
    big = [f for f in files if os.path.getsize(os.path.join(out, f)) > MAX_FILE]
    if big:
        sys.exit(f"over 16 MB: {big}")
    man = {f: sha(os.path.join(out, f)) for f in files}
    json.dump(man, open(os.path.join(out, "..", "manifest.json"), "w"), indent=0, sort_keys=True)
    live = json.load(open(PUBLISHED)) if os.path.exists(PUBLISHED) else {}
    changed = [f for f in files if f != "index.html" and live.get(f) != man[f]]
    removed = sorted(set(live) - set(man) - {"index.html"})
    batches, cur, cur_b = [], {}, 0
    for f in changed:
        b = os.path.getsize(os.path.join(out, f))
        if len(cur) >= MAX_FILES - 5 or cur_b + b > MAX_BYTES - 4_000_000:
            batches.append(cur); cur, cur_b = {}, 0
        cur[f] = os.path.join(out, f); cur_b += b
    for f in removed:
        if len(cur) >= MAX_FILES - 5:
            batches.append(cur); cur = {}
        cur[f] = None
    batches.append(cur)
    parent = os.path.dirname(out)
    for old in os.listdir(parent):
        if re.match(r"publish_files(_\d+)?\.json$", old):
            os.remove(os.path.join(parent, old))
    names = []
    for i, bt in enumerate(batches):
        name = os.path.join(parent, "publish_files.json" if len(batches) == 1 else f"publish_files_{i + 1}.json")
        json.dump(bt, open(name, "w"), indent=0)
        names.append(name)
    size = sum(os.path.getsize(os.path.join(out, f)) for f in files)
    print(f"built {len(files)} files, {size / 1e6:.1f} MB from web/ at {rev} -> {out}")
    print(f"to publish: {len(changed)} changed, {len(removed)} removed, in {len(batches)} publish(es):")
    for n in names:
        print("  ", n)
    print(f"Artifact: {ARTIFACT}  (file_path = {os.path.join(out, 'index.html')}, files = the JSON above)")


if __name__ == "__main__":
    main()
