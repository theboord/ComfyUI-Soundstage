#!/usr/bin/env python3
"""Fetch the lifelike people kit (Microsoft Rocketbox, MIT) into web/stage/people/rocketbox/.

    python3 tools/fetch_rocketbox.py              # into this checkout's web/stage/people/rocketbox/
    python3 tools/fetch_rocketbox.py --dest DIR   # somewhere else
    python3 tools/fetch_rocketbox.py --list       # print what it would fetch, download nothing

Run it yourself, once. Nothing in the App, the node pack or the installers calls it. Python standard library only.

What it does:
- Downloads exactly the files the stage loads (web/stage/people/avatarcore.mjs ROCKETBOX, avatars.mjs) from
  github.com/microsoft/Microsoft-Rocketbox at ONE pinned commit (MIT from 2020-11-17 on; earlier commits are not MIT):
  two adult avatars, their colour / normal / opacity textures, the idle, walk, run and seated-idle clips, and the
  repo's LICENSE.md (kept next to the kit). The specular maps and every other Rocketbox file are never fetched.
- Checks every download against the byte size and sha256 recorded here before it is used. A mismatch is deleted.
- Converts each 2048 px TGA texture to the 1024 px PNG the stage asks for (three's FBXLoader has no TGA reader):
  a 2x2 box average, the opacity map keeps its alpha. The TGA itself is not kept.
- Skips every file that is already in place, so running it again is safe and quick.
"""
from __future__ import annotations

import argparse
import hashlib
import os
import ssl
import struct
import sys
import urllib.request
import zlib
from pathlib import Path

PINNED_COMMIT = "0943055db6ec570bcef9f2c8b41c9e5467c808f9"
REPO = "microsoft/Microsoft-Rocketbox"
BASE_URL = f"https://raw.githubusercontent.com/{REPO}/{PINNED_COMMIT}/"
ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DEST = ROOT / "web" / "stage" / "people" / "rocketbox"
TEXTURE_PX = 1024

_AV = "Assets/Avatars/Adults"
_STATIC = "Assets/Animations/all_animations_max_motextr_static"
_XY = "Assets/Animations/all_animations_max_motextr_xy"   # walk and run: the clips with their travel on the root

# (path in the repo at PINNED_COMMIT, path in the kit, bytes, sha256). "tex/*.png" entries are converted from the TGA.
FILES = [
    (f"{_AV}/Male_Adult_01/Export/Male_Adult_01.fbx", "Male_Adult_01.fbx", 521472, "8d1edb51b4dc3427ae2456f4407fc105532c145dd019e53cd42bab31cc948a29"),
    (f"{_AV}/Female_Adult_01/Export/Female_Adult_01.fbx", "Female_Adult_01.fbx", 609152, "8cbaf86576004b96469bc80df123b97fef788f4a7bb3f3eaa616fcfaf55698a3"),
    (f"{_AV}/Male_Adult_01/Textures/m002_body_color.tga", "tex/m002_body_color.png", 12582956, "6a048a6b2140a1f5293798ca286be64fd0de6d79572e1273ff5765bd578f463f"),
    (f"{_AV}/Male_Adult_01/Textures/m002_body_normal.tga", "tex/m002_body_normal.png", 12582956, "c9892e80c56890f6f5365627835286c2d4d2cc34cc473f6788fe3d560a52fb69"),
    (f"{_AV}/Male_Adult_01/Textures/m002_head_color.tga", "tex/m002_head_color.png", 12582956, "f5b64e4894930d438f7c419c3c9d0bba1f95fa4de9af078b762ea55bfca1ab85"),
    (f"{_AV}/Male_Adult_01/Textures/m002_head_normal.tga", "tex/m002_head_normal.png", 12582956, "5ef5ae404c9276f17641e392d0d4bdbe5fb23e94f28238b23a381e6a357c42ea"),
    (f"{_AV}/Male_Adult_01/Textures/m002_opacity_color.tga", "tex/m002_opacity_color.png", 16777260, "53818d3f45519451edd2bc60d6e59cd4057ecd381827463c5503da0439d0a5cf"),
    (f"{_AV}/Female_Adult_01/Textures/f001_body_color.tga", "tex/f001_body_color.png", 12582956, "c038b01c5d05831c3f4e8c6daa18394e8a4851372acd3fcbdf30e7ee53c56cae"),
    (f"{_AV}/Female_Adult_01/Textures/f001_body_normal.tga", "tex/f001_body_normal.png", 12582956, "86b9b5a5aa73bd97244b35f97f3799c31b3db70426d7d607cbdc2dd271ace346"),
    (f"{_AV}/Female_Adult_01/Textures/f001_head_color.tga", "tex/f001_head_color.png", 12582956, "0d3153c59c54908d5f5194ffe3a7d882351f0dd74f9ef44ab3a2f164a3bf9d8e"),
    (f"{_AV}/Female_Adult_01/Textures/f001_head_normal.tga", "tex/f001_head_normal.png", 12582956, "522f3372283ea4161ed56d85471be15e02628df73a966447e4456bc169d310b2"),
    (f"{_AV}/Female_Adult_01/Textures/f001_opacity_color.tga", "tex/f001_opacity_color.png", 16777260, "12c9c366814e665687fe64056421213686b50a972a5ad47295f247d6a8ff7369"),
    (f"{_STATIC}/m_idle_neutral_01.max.fbx", "anim/m_idle_neutral_01.max.fbx", 2418544, "818cc185af21390575f7fbfdeb3012ba2ce5969fbcb220ea725a2617b339a6e2"),
    (f"{_XY}/m_walk_neutral_01.max.fbx", "anim/m_walk_neutral_01.max.fbx", 994336, "e6805ae6b6b49fe10f06c1b17b14ddde90d09b9fea689ac34793df252f44dcd0"),
    (f"{_XY}/m_run_neutral_01.max.fbx", "anim/m_run_neutral_01.max.fbx", 868752, "5a22052ea750805ea7e097310f36cd448c838e7c88bc842a78632d9606869fa8"),
    (f"{_STATIC}/f_idle_neutral_01.max.fbx", "anim/f_idle_neutral_01.max.fbx", 2959360, "fd68b33ea9e290dc734ca8c3a71ef5842bb2dfe719853ff84f6336d06d39fdcb"),
    (f"{_XY}/f_walk_neutral_01.max.fbx", "anim/f_walk_neutral_01.max.fbx", 993792, "20238709c689d46f5864aebaa58918cc1233cb9045b24aa4d58cf2752786a73b"),
    (f"{_XY}/f_run_neutral_01.max.fbx", "anim/f_run_neutral_01.max.fbx", 877504, "f615a83d50f2b5671877c7449bce557885f4575517b6d83d588b16428f913e51"),
    (f"{_STATIC}/m_sit_chair_idle_neutral_01.max.fbx", "anim/m_sit_chair_idle_neutral_01.max.fbx", 5868640, "c5aeab85a7daa50770f70644b1651ff7811594500a702e8b454e7386566e1df2"),
    (f"{_STATIC}/f_sit_chair_idle_neutral_01.max.fbx", "anim/f_sit_chair_idle_neutral_01.max.fbx", 5562720, "45a11c11fa22364eb0ea0a0f20c05771aeefa92a7fbe89361eed90e218e58abb"),
    ("LICENSE.md", "LICENSE.md", 1066, "17474e386e0b9e1a700cc3d06b2b0882a2c376d9c6b49c7f8274409b8f8d2352"),
]

_urlopen = urllib.request.urlopen   # tests replace this; nothing else touches the network


class FetchError(Exception):
    pass


class CertificateError(FetchError):
    """HTTPS can't be verified on this Python: stop at once (every other file would fail the same way)."""


CERT_HINT = ("this Python can't verify HTTPS certificates. On macOS with the python.org installer, run "
             "\"/Applications/Python 3.x/Install Certificates.command\" once; or `pip install certifi` in this Python. "
             "The script never turns certificate checks off.")


def _ssl_context() -> ssl.SSLContext:
    """The system's trust store, or certifi's when it is installed (the python.org macOS build ships with none)."""
    try:
        import certifi  # noqa: PLC0415 - optional, not stdlib: used only when present
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ssl.create_default_context()


# ------------------------------------------------------------------------------------------------ TGA -> PNG (stdlib)
def read_tga(data: bytes) -> tuple[int, int, int, bytes]:
    """(width, height, channels, top-down RGB/RGBA bytes) of an uncompressed (type 2) or RLE (type 10) 24/32-bit TGA."""
    if len(data) < 18:
        raise FetchError("not a TGA file (too short)")
    idlen, cmaptype, imgtype = data[0], data[1], data[2]
    w, h = struct.unpack_from("<HH", data, 12)
    bpp, desc = data[16], data[17]
    if cmaptype != 0 or imgtype not in (2, 10) or bpp not in (24, 32) or not w or not h:
        raise FetchError(f"unsupported TGA (type {imgtype}, {bpp} bpp, colour map {cmaptype})")
    if desc & 0x10:
        raise FetchError("unsupported TGA (right-to-left pixel order)")
    n = bpp // 8
    pos, size = 18 + idlen, w * h * n
    if imgtype == 2:
        px = data[pos:pos + size]
    else:
        out, i = bytearray(), pos
        while len(out) < size:
            if i >= len(data):
                raise FetchError("TGA run-length data ends early")
            c = data[i]
            i += 1
            count = (c & 0x7F) + 1
            if c & 0x80:
                out += data[i:i + n] * count
                i += n
            else:
                out += data[i:i + n * count]
                i += n * count
        px = bytes(out[:size])
    if len(px) != size:
        raise FetchError("TGA pixel data is short")
    rgb = bytearray(size)                       # BGR(A) -> RGB(A)
    rgb[0::n], rgb[1::n], rgb[2::n] = px[2::n], px[1::n], px[0::n]
    if n == 4:
        rgb[3::n] = px[3::n]
    stride = w * n
    rows = [bytes(rgb[y * stride:(y + 1) * stride]) for y in range(h)]
    if not desc & 0x20:                         # bottom-left origin (the usual one): flip to top-down
        rows.reverse()
    return w, h, n, b"".join(rows)


def half(w: int, h: int, n: int, px: bytes) -> tuple[int, int, bytes]:
    """A 2x2 box average: (w/2, h/2, pixels). Width and height must be even."""
    if w % 2 or h % 2:
        raise FetchError(f"can't halve a {w} x {h} texture")
    stride, ow, oh = w * n, w // 2, h // 2
    out = bytearray(ow * oh * n)
    ostride = ow * n
    for y in range(oh):
        r0, r1 = px[2 * y * stride:(2 * y + 1) * stride], px[(2 * y + 1) * stride:(2 * y + 2) * stride]
        row = bytearray(ostride)
        for c in range(n):
            a, b, d, e = r0[c::2 * n], r0[c + n::2 * n], r1[c::2 * n], r1[c + n::2 * n]
            row[c::n] = bytes((p + q + r + s + 2) >> 2 for p, q, r, s in zip(a, b, d, e))
        out[y * ostride:(y + 1) * ostride] = row
    return ow, oh, bytes(out)


def png_bytes(w: int, h: int, n: int, px: bytes) -> bytes:
    """An 8-bit RGB (n=3) or RGBA (n=4) PNG, filter 0 on every row."""
    def chunk(kind: bytes, body: bytes) -> bytes:
        return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body) & 0xFFFFFFFF)
    stride = w * n
    raw = b"".join(b"\x00" + px[y * stride:(y + 1) * stride] for y in range(h))
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6 if n == 4 else 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def tga_to_png(data: bytes, max_px: int = TEXTURE_PX) -> bytes:
    w, h, n, px = read_tga(data)
    while max(w, h) > max_px:
        w, h, px = half(w, h, n, px)
    return png_bytes(w, h, n, px)


# ------------------------------------------------------------------------------------------------ download + install
def download(url: str, size: int, sha256: str) -> bytes:
    """The whole file, checked against its size and sha256; FetchError otherwise."""
    try:
        with _urlopen(urllib.request.Request(url, headers={"User-Agent": "soundstage-fetch-rocketbox"}), timeout=60,
                      context=_ssl_context()) as r:
            data = r.read()
    except FetchError:
        raise
    except Exception as e:
        if "CERTIFICATE_VERIFY_FAILED" in str(e) or isinstance(getattr(e, "reason", None), ssl.SSLCertVerificationError):
            raise CertificateError(CERT_HINT) from e  # noqa: BLE001 - network errors of every kind become one plain message
        raise FetchError(f"download failed: {e}") from e
    if len(data) != size:
        raise FetchError(f"wrong size: {len(data)} bytes, expected {size}")
    got = hashlib.sha256(data).hexdigest()
    if got != sha256:
        raise FetchError(f"sha256 mismatch: {got}, expected {sha256}")
    return data


def _write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".part")
    tmp.write_bytes(data)
    os.replace(tmp, path)


def _present(path: Path, size: int, converted: bool) -> bool:
    """Already installed: a converted texture by its presence, a copied file by its exact size."""
    if not path.is_file():
        return False
    return converted or path.stat().st_size == size


def fetch(dest: Path = DEFAULT_DEST, out=print) -> bool:
    dest = Path(dest)
    out(f"Microsoft Rocketbox (MIT) at commit {PINNED_COMMIT[:12]} -> {dest}")
    failed = []
    for i, (src, rel, size, sha) in enumerate(FILES, 1):
        target = dest / rel
        converted = src.endswith(".tga")
        tag = f"[{i:2d}/{len(FILES)}] {rel}"
        if _present(target, size, converted):
            out(f"{tag}: already there, skipped")
            continue
        out(f"{tag}: downloading {size / 1e6:.1f} MB")
        try:
            data = download(BASE_URL + src, size, sha)
            _write(target, tga_to_png(data) if converted else data)
        except CertificateError as e:
            out(f"{tag}: FAILED, {e}")
            out(f"FAILED: nothing more was downloaded: {e}")
            return False
        except FetchError as e:
            out(f"{tag}: FAILED, {e}")
            failed.append(rel)
            continue
        out(f"{tag}: ok")
    if failed:
        out(f"FAILED: {len(failed)} of {len(FILES)} files did not install ({', '.join(failed)}). Run it again to retry; people show as stand-ins until it succeeds.")
        return False
    out(f"SUCCESS: the Rocketbox people kit is in {dest}. Reload the App: men and women now show as lifelike people.")
    return True


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dest", default=str(DEFAULT_DEST), help="the kit folder (default: web/stage/people/rocketbox/ in this checkout)")
    ap.add_argument("--list", action="store_true", help="print the pinned URLs and sizes, download nothing")
    a = ap.parse_args(argv)
    if a.list:
        for src, rel, size, _ in FILES:
            print(f"{size:>10}  {BASE_URL + src}  ->  {rel}")
        return 0
    return 0 if fetch(Path(a.dest)) else 1


if __name__ == "__main__":
    sys.exit(main())
