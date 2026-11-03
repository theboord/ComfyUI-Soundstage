#!/usr/bin/env python3
"""Render the README's text images (banner, headers, buttons, step and feature cards) in the App's look.

Each image is a small HTML page in Space Grotesk (web/vendor/fonts) screenshotted by headless Chrome at 2x,
so GitHub shows our own type through its image proxy. Colours are Comfy Org's brand tokens (comfy.org), which
the App theme (web/ui/theme.mjs) already uses. Animated cards get their GIF composited under the card by ffmpeg.

    python3 tools/readme_media/make_media.py            # writes docs/media/readme_v4/*.png|gif
"""
import os, shutil, subprocess, sys, tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MEDIA = ROOT / "docs" / "media"
OUT = MEDIA / "readme_v4"
FONTS = ROOT / "web" / "vendor" / "fonts"
CHROME = os.environ.get("CHROME", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")

# Comfy Org brand tokens (comfy.org site CSS) = the App's theme tokens (web/ui/theme.mjs).
INK = "#211927"        # --color-primary-comfy-ink        (App bg)
INK_LIGHT = "#2a2330"  # --color-primary-comfy-ink-light  (App raised)
SITE_BG = "#1d1622"    # --color-site-bg-soft
YELLOW = "#f2ff59"     # --color-primary-comfy-yellow     (App accent)
WHITE = "#f0efed"      # --color-primary-warm-white       (App text)
CANVAS = "#c2bfb9"     # --color-primary-comfy-canvas     (muted text)
BORDER = "rgba(255,255,255,0.10)"  # --site-border-subtle (#ffffff1a)

BASE_CSS = f"""
@font-face {{ font-family:G; font-weight:400; src:url('{FONTS.as_uri()}/space-grotesk-400.woff2') format('woff2'); }}
@font-face {{ font-family:G; font-weight:500; src:url('{FONTS.as_uri()}/space-grotesk-500.woff2') format('woff2'); }}
@font-face {{ font-family:G; font-weight:600; src:url('{FONTS.as_uri()}/space-grotesk-600.woff2') format('woff2'); }}
@font-face {{ font-family:G; font-weight:700; src:url('{FONTS.as_uri()}/space-grotesk-700.woff2') format('woff2'); }}
* {{ box-sizing:border-box; margin:0; padding:0; }}
html, body {{ background:transparent; font-family:G, sans-serif; color:{WHITE}; -webkit-font-smoothing:antialiased; overflow:hidden; }}
.box {{ background:{INK}; border:1px solid {BORDER}; border-radius:18px; overflow:hidden; }}
.y {{ color:{YELLOW}; }}
"""


def shot(name, w, h, body, css=""):
    """Screenshot an HTML body at w x h CSS px, 2x, transparent background."""
    tmp = Path(tempfile.mkdtemp(prefix="rmv4_"))
    page = tmp / "p.html"
    page.write_text(f"<!doctype html><meta charset=utf-8><style>{BASE_CSS}{css}</style><body>{body}</body>", "utf-8")
    out = OUT / f"{name}.png"
    subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=2",
                    f"--user-data-dir={tmp/'prof'}", "--allow-file-access-from-files", "--virtual-time-budget=3000",
                    "--default-background-color=00000000", f"--window-size={w},{h}", f"--screenshot={out}", page.as_uri()],
                   check=True, capture_output=True)
    shutil.rmtree(tmp, ignore_errors=True)
    return out


TMP = Path(tempfile.mkdtemp(prefix="rmv4_frames_"))


def media(p):
    q = Path(p)
    return (q if q.is_absolute() else MEDIA / p).as_uri()


def still(gif, n, name, crop=None):
    """One frame of an approved README GIF, as a still for a card (kept out of docs/media)."""
    out = TMP / f"{name}.png"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(MEDIA / gif), "-vf", f"select=eq(n\\,{n})" + (f",crop={crop}" if crop else ""), "-frames:v", "1",
                    str(out)], check=True)
    return str(out)


# ---------- banner ----------
def banner():
    body = f"""
<div class=box style="width:880px;height:300px;position:relative;background:
  radial-gradient(120% 90% at 85% 0%, rgba(73,55,139,.55), transparent 60%), {INK};">
  <div style="position:absolute;left:56px;top:56px;">
    <img src="{media('logo.svg')}" style="height:84px;display:block">
    <div style="margin-top:26px;font-size:40px;font-weight:600;letter-spacing:-.01em;line-height:1.1">
      A real 3D film set <span class=y>inside ComfyUI</span></div>
    <div style="margin-top:14px;font-size:19px;color:{CANVAS}">Script in, finished scene out. 100% open weights, on your own GPU.</div>
  </div>
  <div style="position:absolute;right:28px;top:26px;font-size:15px;font-weight:600;color:{INK};background:{YELLOW};
    border-radius:999px;padding:7px 14px;">#OpenSourceHiggsfield</div>
</div>"""
    shot("banner", 880, 300, body)


# ---------- section headers ----------
def header(name, text, sub=""):
    body = f"""
<div class=box style="width:880px;height:76px;display:flex;align-items:center;gap:16px;padding:0 28px;">
  <div style="width:6px;height:34px;border-radius:3px;background:{YELLOW}"></div>
  <div style="font-size:30px;font-weight:600;letter-spacing:-.01em">{text}</div>
  <div style="margin-left:auto;font-size:16px;color:{CANVAS}">{sub}</div>
</div>"""
    shot(name, 880, 76, body)


# ---------- buttons ----------
def button(name, label, primary=False):
    bg, fg, bd = (YELLOW, INK, YELLOW) if primary else (INK_LIGHT, WHITE, "rgba(255,255,255,.18)")
    body = f"""
<div style="width:272px;height:60px;border-radius:999px;background:{bg};color:{fg};border:1.5px solid {bd};
  display:flex;align-items:center;justify-content:center;font-size:21px;font-weight:600;letter-spacing:.005em">{label}</div>"""
    shot(name, 272, 60, body)


# ---------- cards ----------
CARD_W, CARD_MEDIA_H = 430, 242


def card(name, title, line, src=None, pos="center", fit="cover", text_only=None, hole=False, w=CARD_W, mh=CARD_MEDIA_H,
         num=None):
    if hole:
        m = f'<div style="height:{mh}px;background:transparent"></div>'
    elif src:
        m = (f'<div style="height:{mh}px;background:#000;overflow:hidden"><img src="{media(src)}" '
             f'style="width:100%;height:100%;object-fit:{fit};object-position:{pos};display:block"></div>')
    else:
        m = f'<div style="height:{mh}px;background:{INK_LIGHT};position:relative;overflow:hidden">{text_only}</div>'
    badge = (f'<div style="position:absolute;left:16px;top:16px;width:44px;height:44px;border-radius:50%;background:{YELLOW};'
             f'color:{INK};font-size:24px;font-weight:700;display:flex;align-items:center;justify-content:center">{num}</div>'
             if num else "")
    cap_h = 104 if w < 600 else 86
    body = f"""
<div class=box style="width:{w}px;height:{mh + cap_h}px;position:relative;{'background:transparent;' if hole else ''}">
  {m}{badge}
  <div style="height:{cap_h}px;background:{INK};padding:{14 if w < 600 else 16}px 20px 0;border-top:1px solid {BORDER}">
    <div style="font-size:{22 if w < 600 else 24}px;font-weight:600;line-height:1.15" class=y>{title}</div>
    <div style="margin-top:6px;font-size:{16 if w < 600 else 18}px;line-height:1.3;color:{WHITE}">{line}</div>
  </div>
</div>"""
    return shot(name, w, mh + cap_h, body)


def gif_card(name, title, line, gif, step=1, fps=8, out_w=860, colors=96):
    """A card whose media area is an animated GIF: render the card with a transparent hole, lay it over the GIF.

    GIF has 1-bit alpha, and a transparent palette entry stops ffmpeg's frame differencing (6 MB instead of ~0.3 MB),
    so the rounded corners are filled with GitHub's dark page colour (#0d1117): rounded on dark, near-square on light."""
    from PIL import Image
    frame = card(name + "_frame", title, line, hole=True)
    W, MH = CARD_W * 2, CARD_MEDIA_H * 2
    card_h = Image.open(frame).size[1]
    out = OUT / f"{name}.gif"
    fc = (f"[0:v]select='not(mod(n\\,{step}))',setpts=N/{fps}/TB,scale={W}:{MH}:force_original_aspect_ratio=increase,"
          f"crop={W}:{MH},pad={W}:{card_h}:0:0:color=black@0,format=rgba[g];color=c=#0d1117:s={W}x{card_h}[bg];"
          f"[g][1:v]overlay=0:0:format=auto:shortest=1[c];[bg][c]overlay=0:0:shortest=1,scale={out_w}:-1:flags=lanczos,split[a][b];"
          f"[a]palettegen=max_colors={colors}:reserve_transparent=0[p];"
          f"[b][p]paletteuse=dither=none:diff_mode=rectangle")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(MEDIA / gif), "-loop", "1", "-i", str(frame),
                    "-filter_complex", fc, "-r", str(fps), "-loop", "0", str(out)], check=True)
    frame.unlink()
    return out


DRIVE_ART = f"""
<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:34px;
  background:radial-gradient(80% 90% at 50% 40%, rgba(242,255,89,.10), transparent 70%)">
  <div style="display:grid;grid-template-columns:repeat(3,52px);grid-template-rows:52px 52px;gap:8px">
    <div></div><div class=k>W</div><div></div><div class=k>A</div><div class=k>S</div><div class=k>D</div>
  </div>
  <div style="text-align:left">
    <div style="display:flex;gap:10px;align-items:center"><div class="k on">D</div>
      <div style="font-size:18px;color:{CANVAS}">drive the<br>selection</div></div>
    <div style="margin-top:14px;display:flex;gap:10px;align-items:center">
      <div style="font-size:15px;font-weight:600;color:{WHITE};background:#e5484d;border-radius:999px;padding:7px 14px">● REC</div>
      <div style="font-size:15px;color:{CANVAS}">keys on the shot</div></div>
  </div>
</div>
<style>.k{{width:52px;height:52px;border-radius:10px;border:1.5px solid rgba(255,255,255,.22);background:{INK};
display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:600;color:{WHITE}}}
.k.on{{background:{YELLOW};color:{INK};border-color:{YELLOW}}}</style>"""


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    chase = still("car_chase.gif", 51, "car_chase_still", "800:220:0:25")
    mocap = still("mocap.gif", 30, "mocap_still", "720:268:0:0")
    banner()
    header("h_judging", "Judging it? Start here", "3 steps · no install")
    header("h_inside", "What's inside", "all on main today")
    header("h_install", "Install", "ComfyUI · NVIDIA GPU")
    button("btn_watch", "▶&nbsp; Watch", primary=True)
    button("btn_try", "Try it in your browser")
    button("btn_install", "Install")
    # Judging steps: full-width cards with a number badge.
    card("step1", "Open the try-it demo", "No install. It opens on the clay stage becoming the finished shot.",
         chase, w=880, mh=300, num=1, fit="contain")
    card("step2", "Open the live stage, press Play", "Select the red car and give it a stunt in its properties.",
         "camera_keys.jpg", w=880, mh=300, num=2, pos="center 60%")
    card("step3", "Take the What's new tour", "A Live / Replayed badge says what runs in your browser and what is a recorded run.",
         "dailies.jpg", w=880, mh=300, num=3, pos="center 40%")
    # Feature cards.
    card("card_block", "Block in 3D", "Pose people, cars and horses in true-scale clay, on real camera rigs.", "pose_3d.jpg", pos="center 70%")
    card("card_clay", "Clay → Hollywood", "FLUX 3 Klein + LTX-2.5 render with sound, on your blocking. Up to 2624×1408.", "takecheck.jpg", pos="20% 35%")
    gif_card("card_stunts", "Stunts &amp; collisions", "Climb, mount, carry, crash crates. J-turns, donuts, handbrake 180s.", "live3d_climb.gif")
    card("card_drive", "Drive anything", "Press D: drive a car, person, horse or boat. ● REC records the take.", text_only=DRIVE_ART)
    card("card_perf", "Real performances", "Your body, face and voice drive the character, lip sync included.", mocap, fit="contain")
    card("card_v2s", "Video → 3D", "Drop a clip: set, tracked camera and performer rebuilt in 3D. Early version.", "video_to_stage.jpg", pos="left top")
    card("card_oneclick", "✦ One-click + Ask", "52 one-click effects on any take. ✦ Ask answers how-to and shows you.", "director.jpg", pos="right center")
    card("card_cut", "Cut &amp; deliver", "NLE timeline with generated sound. Out to Avid, Premiere, Resolve, FCP, VFX.", "timeline.jpg", pos="left top")
    shrink()


def shrink(limit=700_000):
    """Keep every PNG well under GitHub's comfortable size: big photo cards go to a 256-colour palette."""
    from PIL import Image
    for f in OUT.glob("*.png"):
        if f.stat().st_size > limit:
            Image.open(f).convert("RGBA").quantize(256, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.FLOYDSTEINBERG).save(f, optimize=True)


if __name__ == "__main__":
    sys.exit(main())
