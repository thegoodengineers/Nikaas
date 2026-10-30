"""Showcase film of the deployed site: a browser window on a gradient wallpaper, no voice (~35 s).

Records one continuous run through the live site with Playwright (GPU WebGL), keeps the good moments
(timestamps are logged while recording), and composes them into a 1920x1080 browser-window frame with ffmpeg.

Usage (repo root):  python video/film.py [--url http://...]
Writes video/out/nikaas_film.mp4. Needs Playwright (playwright install chromium), ffmpeg and Pillow.
"""
import argparse
import pathlib
import shutil
import subprocess
import tempfile
import time

from PIL import Image, ImageDraw, ImageFilter, ImageFont
from playwright.sync_api import sync_playwright

LIVE = "http://nikaas-webbucket-hbkfctr0cw8s.s3-website.ap-south-1.amazonaws.com"
ap = argparse.ArgumentParser()
ap.add_argument("--url", default=LIVE)
a = ap.parse_args()

W, H = 1920, 1080             # output
CW, CH = 1600, 900            # browser content (= recorded viewport, no scaling)
X0, Y0 = (W - CW) // 2, 53    # window top-left
BAR = 74                      # tab strip + toolbar height
OUT = pathlib.Path("video/out")
OUT.mkdir(parents=True, exist_ok=True)
tmp = pathlib.Path(tempfile.mkdtemp())

SMOOTH = """async ([to, ms]) => { const from = scrollY, t0 = performance.now();
  await new Promise(done => { const step = now => { const k = Math.min(1, (now - t0) / ms);
    const e = k < .5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2; scrollTo(0, from + (to - from) * e);
    k < 1 ? requestAnimationFrame(step) : done() }; requestAnimationFrame(step) }) }"""

keep = []  # (start, end) in seconds of the raw recording


def frame_overlay():
    """Wallpaper with a shadow (base) and the window chrome with rounded corners (top)."""
    wall = Image.new("RGB", (W, H))
    top_c, mid_c, bot_c = (236, 72, 120), (122, 70, 190), (52, 92, 220)
    px = wall.load()
    for y in range(H):
        k = y / (H - 1)
        c = [int(top_c[i] + (mid_c[i] - top_c[i]) * k * 2) if k < .5 else int(mid_c[i] + (bot_c[i] - mid_c[i]) * (k - .5) * 2) for i in range(3)]
        for x in range(W):
            px[x, y] = tuple(c)
    win = (X0, Y0, X0 + CW, Y0 + BAR + CH)
    shadow = Image.new("L", (W, H), 0)
    ImageDraw.Draw(shadow).rounded_rectangle((win[0], win[1] + 18, win[2], win[3] + 18), 16, fill=150)
    base = Image.composite(Image.new("RGB", (W, H), (20, 12, 40)), wall, shadow.filter(ImageFilter.GaussianBlur(28)))
    # top layer: wallpaper outside the rounded window, chrome inside the bar, transparent over the page
    mask = Image.new("L", (W, H), 0)
    ImageDraw.Draw(mask).rounded_rectangle(win, 14, fill=255)
    top = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    top.paste(base, (0, 0), Image.eval(mask, lambda v: 255 - v))
    d = ImageDraw.Draw(top)
    d.rounded_rectangle((win[0], win[1], win[2], win[1] + BAR + 14), 14, fill=(32, 33, 36, 255))
    d.rectangle((win[0], win[1] + BAR, win[2], win[1] + BAR + 14), fill=(0, 0, 0, 0))
    f = ImageFont.truetype("C:/Windows/Fonts/segoeui.ttf", 15)
    fb = ImageFont.truetype("C:/Windows/Fonts/segoeuib.ttf", 15)
    for i, c in enumerate([(255, 95, 87), (254, 188, 46), (40, 200, 64)]):
        d.ellipse((X0 + 18 + i * 22, Y0 + 12, X0 + 30 + i * 22, Y0 + 24), fill=c)
    d.rounded_rectangle((X0 + 96, Y0 + 6, X0 + 330, Y0 + 34), 9, fill=(53, 54, 58))   # active tab
    d.rounded_rectangle((X0 + 108, Y0 + 13, X0 + 122, Y0 + 27), 3, fill=(30, 140, 78))  # favicon
    d.text((X0 + 132, Y0 + 10), "Nikaas", font=fb, fill=(232, 234, 237))
    d.rectangle((X0, Y0 + 34, X0 + CW, Y0 + BAR), fill=(53, 54, 58))
    d.rounded_rectangle((X0 + 110, Y0 + 40, X0 + CW - 120, Y0 + 68), 14, fill=(32, 33, 36))
    d.text((X0 + 132, Y0 + 44), a.url.replace("http://", ""), font=f, fill=(200, 203, 208))
    for i, ch in enumerate("‹›↻"):
        d.text((X0 + 20 + i * 28, Y0 + 42), ch, font=fb, fill=(170, 173, 178))
    base.save(tmp / "base.png")
    top.save(tmp / "top.png")


with sync_playwright() as p:
    b = p.chromium.launch(args=["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"])
    ctx = b.new_context(viewport={"width": CW, "height": CH}, record_video_dir=str(tmp), record_video_size={"width": CW, "height": CH})
    t0 = time.monotonic()
    pg = ctx.new_page()
    now = lambda: time.monotonic() - t0  # noqa: E731
    scroll = lambda y, ms: pg.evaluate(SMOOTH, [y, ms])  # noqa: E731

    # 1. Home: the building is already evacuating; a fire at the main entrance re-routes everyone (?fire=MAIN)
    pg.goto(f"{a.url}/?fire=MAIN#/")
    pg.wait_for_function("document.querySelector('.lh-live')?.textContent.includes('of 5')", timeout=60000)
    s = now()
    pg.wait_for_selector("text=Everyone was re-routed", timeout=60000)
    pg.wait_for_timeout(2600)
    keep.append((s + 0.3, now()))

    # 2. the scroll story, the numbers and the FAQ
    s = now()
    film_end = pg.evaluate("(() => { const f = document.getElementById('film'); return f.offsetTop + f.offsetHeight - innerHeight })()")
    scroll(film_end, 5600)
    pg.wait_for_timeout(700)
    stats = pg.evaluate("document.querySelector('.stats').getBoundingClientRect().top + scrollY - 120")
    scroll(stats, 1100)
    pg.wait_for_timeout(1100)
    faq = pg.evaluate("document.querySelector('.faq').getBoundingClientRect().top + scrollY - 90")
    scroll(faq, 1200)
    pg.locator(".faq summary").nth(1).click()
    pg.wait_for_timeout(1600)
    keep.append((s, now()))

    # 3. the Twin: Ayush's 5-floor tower, Nikaas plan (both stair shafts in use)
    pg.click("nav >> text=Twin")
    pg.get_by_role("button", name="5-floor tower (450 people)").click()
    pg.wait_for_timeout(600)
    pg.get_by_role("button", name="Nikaas plan").click()
    pg.wait_for_selector("text=s faster", timeout=60000)
    top_layout = pg.evaluate("document.querySelector('.layout').getBoundingClientRect().top + scrollY - 70")
    s = now()
    scroll(top_layout, 900)
    pg.wait_for_timeout(4400)
    keep.append((s, now()))

    # 4. Live drill: the QR code judges scan
    pg.click("nav >> text=Live drill")
    pg.wait_for_selector(".drill-qr svg", timeout=30000)
    s = now()
    pg.wait_for_timeout(2600)
    keep.append((s, now()))

    raws = [(pg.video.path(), keep)]
    ctx.close()

    # 5. 3D Sim in a fresh session: calm, then the incident and the alarm
    keep = []
    ctx = b.new_context(viewport={"width": CW, "height": CH}, record_video_dir=str(tmp), record_video_size={"width": CW, "height": CH})
    t0 = time.monotonic()
    pg = ctx.new_page()
    pg.goto(f"{a.url}/#/sim")
    pg.wait_for_selector("button:has-text('Begin simulation'):not([disabled])", timeout=60000)
    s = now()
    pg.wait_for_timeout(1000)
    pg.click("button:has-text('Begin simulation')")
    keep.append((s, now() + 0.6))
    pg.click(".d-seg >> text=2×")  # headless rendering runs slow; 2x keeps the calm phase short
    pg.wait_for_function("document.querySelector('.d-clock')?.textContent.toLowerCase().includes('since alarm')", timeout=60000)
    s = now()
    pg.wait_for_timeout(7500)
    keep.append((s - 1.2, now()))

    raws.append((pg.video.path(), keep))
    ctx.close()
    b.close()

frame_overlay()
# keep the logged moments of each recording, join them, and put them in the browser-window frame
cuts, inputs = [], []
for n, (raw, kp) in enumerate(raws):
    sel = "+".join(f"between(t,{s:.2f},{e:.2f})" for s, e in kp)
    inputs += ["-i", raw]
    cuts.append(f"[{n + 1}:v]fps=30,select='{sel}',setpts=N/30/TB[c{n}]")
segs = [e - s for _, kp in raws for s, e in kp]
total = sum(segs)
n_in = len(raws)
vf = (";".join(cuts) + ";" + "".join(f"[c{n}]" for n in range(n_in)) + f"concat=n={n_in}:v=1:a=0[v];"
      f"[0:v][v]overlay={X0}:{Y0 + BAR}:shortest=1[a];[a][{n_in + 1}:v]overlay=0:0,format=yuv420p[out]")
out = OUT / "nikaas_film.mp4"
subprocess.run(["ffmpeg", "-v", "error", "-y", "-loop", "1", "-i", str(tmp / "base.png"), *inputs, "-loop", "1", "-i", str(tmp / "top.png"),
                "-filter_complex", vf, "-map", "[out]", "-t", f"{total:.2f}", "-c:v", "libx264", "-crf", "18", "-preset", "slow",
                "-movflags", "+faststart", str(out)], check=True)
shutil.rmtree(tmp, ignore_errors=True)
(OUT / "film_segments.json").write_text(__import__("json").dumps([round(x, 2) for x in segs]))  # for video/voiceover.py
print(out, f"{total:.1f} s", [f"{x:.1f}" for x in segs])
