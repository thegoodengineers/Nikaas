"""PNG icons for the installable phone app and notifications, drawn from the favicon's exit-sign shapes.
    python scripts/make_icons.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parents[1] / "web" / "public" / "icons"
GREEN = (30, 140, 78, 255)
FIGURE = [(22, 20), (33, 21), (39, 30), (46, 33), (44, 38), (35, 34), (31, 29), (28, 38), (36, 45), (34, 58), (28, 57), (29, 47),
          (21, 41), (17, 51), (8, 53), (7, 47), (14, 45), (18, 33), (13, 35), (10, 42), (5, 40), (10, 29)]


def draw(size: int, bg=GREEN, fg=(255, 255, 255, 255), inset=0.0, rounded=True) -> Image.Image:
    k = 4  # draw large, then downscale for smooth edges
    s = size * k
    im = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    if bg:
        if rounded:
            d.rounded_rectangle([0, 0, s - 1, s - 1], radius=s * 12 // 64, fill=bg)
        else:
            d.rectangle([0, 0, s - 1, s - 1], fill=bg)
    # the favicon draws the figure in a 64 box at translate(6 6) scale(0.82); `inset` shrinks it for maskable icons
    scale = s / 64 * 0.82 * (1 - inset)
    off = s / 64 * 6 * (1 - inset) + s * inset / 2

    def p(x, y):
        return (off + x * scale, off + y * scale)

    w = 4 * scale
    x0, y0 = p(44, 6)
    x1, y1 = p(60, 58)
    d.rounded_rectangle([x0, y0, x1, y1], radius=1.5 * scale, outline=fg, width=int(w))
    cx, cy = p(26, 11)
    d.ellipse([cx - 6 * scale, cy - 6 * scale, cx + 6 * scale, cy + 6 * scale], fill=fg)
    d.polygon([p(x, y) for x, y in FIGURE], fill=fg)
    return im.resize((size, size), Image.LANCZOS)


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    draw(192).save(OUT / "icon-192.png")
    draw(512).save(OUT / "icon-512.png")
    draw(512, inset=0.2, rounded=False).save(OUT / "maskable-512.png")
    draw(180, rounded=False).save(OUT / "apple-touch-icon.png")
    draw(96, bg=None).save(OUT / "badge-96.png")  # monochrome status-bar badge (Android uses its alpha)
    print("icons written to web/public/icons/")
