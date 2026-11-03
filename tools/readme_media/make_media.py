#!/usr/bin/env python3
"""Render the README's images (banner, headers, buttons, hero wipe, step and feature cards) in the App's look.

Text is Space Grotesk (web/vendor/fonts), laid out as small HTML pages and screenshotted by headless Chrome at 2x,
so GitHub shows our own type through its image proxy. Colours are Comfy Org's brand tokens (comfy.org), which the
App theme (web/ui/theme.mjs) already uses.

Every card is one full-width image (880 px): the media on top, a caption band under it. Text is sized for a
390 px phone, where GitHub shows the card at about 0.41x: titles 46 px (about 19 px on the phone), lines 31 px
(about 13 px). Animated cards are GIFs (GitHub only plays MP4 from uploaded assets), each under 5 MB.

Footage comes from the commercial and try-it renders in the share folder (SHARE, default ~/OpenHiggsfieldContest/share);
they are not in the repo, so a rebuild needs that folder.

    python3 tools/readme_media/make_media.py            # writes docs/media/readme_v4/*
"""
import os, shutil, subprocess, sys, tempfile
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
MEDIA = ROOT / "docs" / "media"
OUT = MEDIA / "readme_v4"
FONTS = ROOT / "web" / "vendor" / "fonts"
SHARE = Path(os.environ.get("SHARE", Path.home() / "OpenHiggsfieldContest" / "share"))
CHROME = os.environ.get("CHROME", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")

# Comfy Org brand tokens (comfy.org site CSS) = the App's theme tokens (web/ui/theme.mjs).
INK = "#211927"        # --color-primary-comfy-ink        (App bg)
INK_LIGHT = "#2a2330"  # --color-primary-comfy-ink-light  (App raised)
YELLOW = "#f2ff59"     # --color-primary-comfy-yellow     (App accent)
WHITE = "#f0efed"      # --color-primary-warm-white       (App text)
CANVAS = "#c2bfb9"     # --color-primary-comfy-canvas     (muted text)
BORDER = "rgba(255,255,255,0.10)"  # --site-border-subtle (#ffffff1a)

W = 880  # README column width the images are laid out for

BASE_CSS = f"""
@font-face {{ font-family:G; font-weight:400; src:url('{FONTS.as_uri()}/space-grotesk-400.woff2') format('woff2'); }}
@font-face {{ font-family:G; font-weight:500; src:url('{FONTS.as_uri()}/space-grotesk-500.woff2') format('woff2'); }}
@font-face {{ font-family:G; font-weight:600; src:url('{FONTS.as_uri()}/space-grotesk-600.woff2') format('woff2'); }}
@font-face {{ font-family:G; font-weight:700; src:url('{FONTS.as_uri()}/space-grotesk-700.woff2') format('woff2'); }}
* {{ box-sizing:border-box; margin:0; padding:0; }}
html, body {{ background:transparent; font-family:G, sans-serif; color:{WHITE}; -webkit-font-smoothing:antialiased; overflow:hidden; }}
.y {{ color:{YELLOW}; }}
.pill {{ display:inline-block; font-size:22px; font-weight:600; border-radius:999px; padding:5px 14px; line-height:1.2;
  border:1.5px solid {YELLOW}; color:{YELLOW}; white-space:nowrap; }}
.pill.solid {{ background:{YELLOW}; color:{INK}; }}
"""

TMP = Path(tempfile.mkdtemp(prefix="rmv5_"))
ONLY = set(filter(None, os.environ.get("ONLY", "").split(",")))


def want(name):
    return not ONLY or name in ONLY


def shot(path, w, h, body, css=""):
    """Screenshot an HTML body at w x h CSS px, 2x, transparent background."""
    tmp = Path(tempfile.mkdtemp(prefix="rmv5_s_"))
    page = tmp / "p.html"
    page.write_text(f"<!doctype html><meta charset=utf-8><style>{BASE_CSS}{css}</style><body>{body}</body>", "utf-8")
    subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=2",
                    f"--user-data-dir={tmp/'prof'}", "--allow-file-access-from-files", "--virtual-time-budget=3000",
                    "--default-background-color=00000000", f"--window-size={w},{h}", f"--screenshot={path}", page.as_uri()],
                   check=True, capture_output=True)
    shutil.rmtree(tmp, ignore_errors=True)
    return Path(path)


def ff(*args):
    subprocess.run(["ffmpeg", "-v", "error", "-y", *map(str, args)], check=True)


def frames(src, t0, dur, fps, vf, tag, dn=True):
    """Decode src[t0, t0+dur] at fps through the filter vf into PIL images."""
    d = TMP / tag
    d.mkdir(exist_ok=True)
    ff("-ss", t0, "-t", dur, "-i", src, "-vf", f"fps={fps},{vf}" + (",hqdn3d=3:3:8:8" if dn else ""), d / "%04d.png")
    return [Image.open(p).convert("RGB") for p in sorted(d.glob("*.png"))]


def band(title, line, pill=None, h=None):
    """The caption band under a card's media, rendered at 2x and returned at 1x width W (RGB)."""
    h = h or BAND_H
    p = (f'<span class="pill" style="margin-left:auto">{pill}</span>' if pill else "")
    body = f"""
<div style="width:{W}px;height:{h}px;background:{INK};border-top:1px solid {BORDER};padding:20px 28px 0">
  <div style="display:flex;align-items:center;gap:16px">
    <div class=y style="font-size:46px;font-weight:600;line-height:1.1;letter-spacing:-.01em">{title}</div>{p}
  </div>
  <div style="margin-top:8px;font-size:31px;line-height:1.24;color:{WHITE}">{line}</div>
</div>"""
    out = TMP / f"band_{abs(hash(title + line))}.png"
    shot(out, W, h, body)
    return Image.open(out).convert("RGB").resize((W, h), Image.LANCZOS)


BAND_H = 196


def label(text, solid=False):
    """A small pill label (RGBA, 1x) to lay over footage."""
    out = TMP / f"lab_{abs(hash(text))}.png"
    shot(out, 300, 44, f'<div style="padding:4px"><span class="pill{" solid" if solid else ""}" '
                       f'style="background:{YELLOW if solid else "rgba(33,25,39,.82)"};font-size:20px">{text}</span></div>')
    im = Image.open(out).convert("RGBA")
    bbox = im.getbbox()
    im = im.crop(bbox)
    return im.resize((im.width // 2, im.height // 2), Image.LANCZOS)


def stack(media, bnd):
    c = Image.new("RGB", (W, media.height + bnd.height), INK)
    c.paste(media, (0, 0))
    c.paste(bnd, (0, media.height))
    return c


def save_gif(imgs, name, fps, colors=128, dither="bayer:bayer_scale=5"):
    d = TMP / f"gif_{name}"
    d.mkdir(exist_ok=True)
    for i, im in enumerate(imgs):
        im.save(d / f"{i:04d}.png")
    out = OUT / f"{name}.gif"
    ff("-framerate", fps, "-i", d / "%04d.png", "-filter_complex",
       f"split[a][b];[a]palettegen=max_colors={colors}:stats_mode=full[p];[b][p]paletteuse=dither={dither}:diff_mode=rectangle",
       "-loop", "0", out)
    print(f"{out.name}: {out.stat().st_size/1e6:.2f} MB, {len(imgs)} frames")
    return out


def save_png(im, name):
    out = OUT / f"{name}.png"
    im.save(out, optimize=True)
    if out.stat().st_size > 900_000:
        im.quantize(256, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.FLOYDSTEINBERG).save(out, optimize=True)
    print(f"{out.name}: {out.stat().st_size/1e6:.2f} MB")
    return out


def overlay(im, lab, xy):
    im = im.copy()
    im.paste(lab, xy, lab)
    return im


def sbs(src, t0, dur, fps, tag, half_w=640, half_h=344):
    """A side-by-side clip (left | right, halves half_w x half_h) as two 4:3 halves, 440 x 330 each, side by side."""
    cw = int(half_h * 4 / 3)
    x0 = (half_w - cw) // 2
    L = frames(src, t0, dur, fps, f"crop={cw}:{half_h}:{x0}:0,scale=440:330:flags=lanczos", tag + "_l")
    R = frames(src, t0, dur, fps, f"crop={cw}:{half_h}:{half_w + x0}:0,scale=440:330:flags=lanczos", tag + "_r")
    out = []
    for a, b in zip(L, R):
        c = Image.new("RGB", (W, 330), INK)
        c.paste(a, (0, 0))
        c.paste(b, (440, 0))
        for x in (439, 440):
            for y in range(330):
                c.putpixel((x, y), (242, 255, 89))
        out.append(c)
    return out


def sbs2(left, right, t0, dur, fps, tag):
    """Two clips side by side, each center-cropped to 4:3 and scaled to 440 x 330."""
    vf = "crop=ih*4/3:ih,scale=440:330:flags=lanczos"
    L = frames(left, t0, dur, fps, vf, tag + "_l")
    R = frames(right, t0, dur, fps, vf, tag + "_r")
    out = []
    for a, b in zip(L, R):
        c = Image.new("RGB", (W, 330), INK)
        c.paste(a, (0, 0))
        c.paste(b, (440, 0))
        c.paste(Image.new("RGB", (2, 330), (242, 255, 89)), (439, 0))
        out.append(c)
    return out


# ---------- banner, headers, buttons ----------
def banner():
    body = f"""
<div style="width:880px;height:330px;position:relative;border:1px solid {BORDER};border-radius:18px;overflow:hidden;background:
  radial-gradient(120% 90% at 85% 0%, rgba(73,55,139,.55), transparent 60%), {INK};">
  <div style="position:absolute;left:52px;top:50px;right:40px">
    <img src="{(MEDIA / 'logo.svg').as_uri()}" style="height:80px;display:block">
    <div style="margin-top:26px;font-size:50px;font-weight:600;letter-spacing:-.015em;line-height:1.05">
      A real 3D film set <span class=y>inside ComfyUI</span></div>
    <div style="margin-top:16px;font-size:30px;line-height:1.2;color:{CANVAS}">Script in, finished scene out. 100% open weights, on your own GPU.</div>
  </div>
  <div style="position:absolute;right:26px;top:24px;font-size:20px;font-weight:600;color:{INK};background:{YELLOW};
    border-radius:999px;padding:7px 14px;">#OpenSourceHiggsfield</div>
</div>"""
    shot(OUT / "banner.png", 880, 330, body)


def header(name, text, sub=""):
    body = f"""
<div style="width:880px;height:96px;display:flex;align-items:center;gap:18px;padding:0 28px;background:{INK};
  border:1px solid {BORDER};border-radius:18px">
  <div style="width:8px;height:46px;border-radius:4px;background:{YELLOW}"></div>
  <div style="font-size:44px;font-weight:600;letter-spacing:-.01em">{text}</div>
  <div style="margin-left:auto;font-size:26px;color:{CANVAS}">{sub}</div>
</div>"""
    shot(OUT / f"{name}.png", 880, 96, body)


def button(name, label_, primary=False):
    bg, fg, bd = (YELLOW, INK, YELLOW) if primary else (INK_LIGHT, WHITE, "rgba(255,255,255,.18)")
    body = f"""
<div style="width:272px;height:60px;border-radius:999px;background:{bg};color:{fg};border:1.5px solid {bd};
  display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:600;letter-spacing:.005em">{label_}</div>"""
    shot(OUT / f"{name}.png", 272, 60, body)


# ---------- the cards ----------
C = SHARE / "Commercial"
TRY = SHARE / "TryIt_Refresh3"


def hero():
    """Clay → Final wipe on the J-turn redo (the try-it demo's first screen, 2560x688 = clay | final).

    800 x 364 (cropped to 2.2:1) at 8 fps keeps it under 5 MB; README shows it at 880."""
    src = TRY / "tr3_hero_jturn_redo.mp4"
    fps, dur, hw, hh = 8, 5.0, 800, 364
    clay = frames(src, 0, dur, fps, f"crop=1280:582:0:70,scale={hw}:{hh}:flags=lanczos", "hero_c")
    fin = frames(src, 0, dur, fps, f"crop=1280:582:1280:70,scale={hw}:{hh}:flags=lanczos", "hero_f")
    lc, lf = label("3D stage (clay)"), label("Final render", solid=True)
    import math
    out = []
    n = min(len(clay), len(fin))
    for i in range(n):
        x = int(hw * (0.5 - 0.36 * math.cos(2 * math.pi * i / n)))
        c = fin[i].copy()
        c.paste(clay[i].crop((0, 0, x, hh)), (0, 0))
        c.paste(Image.new("RGB", (3, hh), (242, 255, 89)), (x - 1, 0))
        c.paste(lc, (12, 12), lc)
        c.paste(lf, (hw - lf.width - 12, 12), lf)
        out.append(c)
    if want("hero"):
        save_gif(out, "hero_jturn", fps)
    return out[n // 4].resize((W, int(hh * W / hw)), Image.LANCZOS)


def step(name, num, title, line, media):
    """A judging step: full-width still, number badge, caption band."""
    b = band(f'<span style="display:inline-flex;width:52px;height:52px;border-radius:50%;background:{YELLOW};color:{INK};'
             f'font-size:32px;font-weight:700;align-items:center;justify-content:center;margin-right:14px;vertical-align:middle">'
             f'{num}</span>{title}', line, h=200)
    save_png(stack(media, b), name)


def still(src, t, vf, tag):
    return frames(src, t, 0.1, 10, vf, tag, dn=False)[0]


def gif_card(name, title, line, pill, imgs, fps, colors=128):
    if want(name):
        b = band(title, line, pill=pill)
        save_gif([stack(m, b) for m in imgs()], name, fps, colors=colors)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    if not ONLY:
        for f in OUT.glob("*"):
            f.unlink()
    if want("text"):
        banner()
        header("h_judging", "Judging it? Start here", "3 steps · no install")
        header("h_inside", "What's inside", "on main today")
        header("h_install", "Install", "ComfyUI · NVIDIA GPU")
        button("btn_watch", "▶&nbsp; Watch", primary=True)
        button("btn_try", "Try it in your browser", primary=True)
        button("btn_install", "Install")

    ask2 = C / "v6" / "captures" / "CAP-v6_ask2.mp4"
    if want("hero") or want("steps"):
        hero_mid = hero()
    if want("steps"):
        step("step1", 1, "Open the try-it demo",
             "No install. It opens on the clay stage becoming the shot. Or load a script and watch it break down.",
             hero_mid.crop((0, 0, W, 300)))
        step("step2", 2, "Open the live stage, press Play", "Select the red car and give it a stunt in its properties.",
             still(ask2, 0.2, "crop=1386:472:116:330,scale=880:300:flags=lanczos", "s2"))
        step("step3", 3, "Take the What's new tour",
             "The badge says what runs live in your browser and what replays a real GPU run.",
             still(ask2, 0.2, "crop=1000:136:0:0,scale=880:-1:flags=lanczos", "s3"))

    # You block it, it renders: the boat, clay | Final (the same shot, frame for frame).
    B = C / "v5_renders" / "boat"
    gif_card("card_boat", "You block it. It renders.",
             "Left, the 3D stage. Right, the Final render of the same shot: FLUX 3 Klein + LTX-2.5, with sound.", "Final render",
             lambda: sbs2(B / "boat3_clay_color.mp4", B / "boat3_finalhq_loose_sound_s2201_00001_.mp4", 0.3, 4.0, 8, "boat"), 8)
    # Night, rain, sound: the car-pass plate, trimmed to the pass.
    cp = C / "v5_renders" / "carpass" / "angles" / "cpa_closeup_final_sound_s1101_00001_.mp4"
    gif_card("card_carpass", "Night, rain, sound",
             "Police cars come out of the rain toward the lens, their sound generated with the picture.", "Final render",
             lambda: frames(cp, 0.2, 2.4, 8, "crop=1984:992:0:48,scale=880:440:flags=lanczos", "cp"), 8, colors=96)
    # Stunts & SFX rigs: the explosion run, a live stage capture.
    ex = C / "v5_renders" / "expl" / "expl2_final_ff6112_sound_s6101_00001_.mp4"
    gif_card("card_sfx", "Stunts &amp; SFX rigs",
             "Explosions, fire, squibs and breakaway glass, cued in time. Cars and people thrown by physics.", "Final render",
             lambda: frames(ex, 0.8, 3.6, 8, "crop=1984:992:0:48,scale=880:440:flags=lanczos", "ex"), 8, colors=112)
    # Drive anything: the scripted Drive capture.
    dr = C / "v6" / "captures" / "CAP-v6d_drive.mp4"
    gif_card("card_drive", "Drive anything",
             "Select a car, person, horse or boat and press D. ● REC keys the take; Drive takes over from keys.", "Stage capture",
             lambda: frames(dr, 5.0, 6.3, 8, "crop=1386:693:116:205,scale=880:440:flags=lanczos", "dr", dn=False), 8)
    # Video → 3D: source | reshoot.
    gif_card("card_v2s", "Video → 3D",
             "Drop a clip: set, camera and performer come back in 3D. Reshoot it; ↻ Regenerate or Fix this object.", "Early version",
             lambda: sbs(TRY / "tr3_v2s_source_vs_reshoot.mp4", 0.5, 4.0, 8, "v2s"), 8)
    # Passes: the depth wipe on a Video → 3D result.
    if want("card_passes"):
        b = band("Passes", "Check any take's depth, pose, talking and alpha matte, wiped against the picture.")
        m = Image.open(SHARE / "QA" / "passes_viewer" / "35_v2s_depth_wipe_vs_source.png").convert("RGB")
        m = m.crop((24, 24, 1416, 876)).resize((W, int(852 * W / 1392)), Image.LANCZOS)
        save_png(stack(m, b), "card_passes")
    # Ask: the how-to answer with Show me.
    if want("card_ask"):
        b = band("✦ Ask", "Ask how and it lights up the real buttons. Or say what you want: see the plan, press Apply.")
        save_png(stack(still(ask2, 7.0, "crop=920:460:600:345,scale=880:440:flags=lanczos", "ask"), b), "card_ask")
    # Cut & deliver: the Cut editor (README media).
    gif_card("card_cut", "Cut &amp; deliver",
             "Real-time timeline with sound. Out to Avid, Premiere, Resolve, FCP. Blender and Unreal round trip.", None,
             lambda: frames(MEDIA / "cut_editor.gif", 0, 7.0, 8, "scale=880:-2:flags=lanczos", "cut", dn=False), 8, colors=160)

    # Sound versions to link from the captions.
    if want("mp4"):
        for name, src in [("jturn_final_sound.mp4", C / "v5_renders" / "jturn_redo" / "jturn_final_sound_s5101_small.mp4"),
                          ("boat_final_sound.mp4", C / "v5_renders" / "boat" / "boat3_finalhq_loose_sound_s2201_00001__small.mp4"),
                          ("carpass_final_sound.mp4", C / "v5_renders" / "carpass" / "angles" / "cpa_closeup_final_sound_s1101_00001__small.mp4"),
                          ("explosion_final_sound.mp4", C / "v5_renders" / "expl" / "expl2_final_ff6112_sound_s6101_00001__small.mp4"),
                          ("intro_mike.mp4", C / "v5_presenter" / "wip" / "OPENING_ripple_lot_small.mp4")]:
            ff("-i", src, "-c:v", "libx264", "-crf", "28", "-preset", "slow", "-vf", "scale=-2:'min(720,ih)'", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k",
               "-movflags", "+faststart", OUT / name)
            print(f"{name}: {(OUT / name).stat().st_size/1e6:.2f} MB")
    shutil.rmtree(TMP, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
