"""Pictures for the building cards (#/buildings): each building rendered by the 3D simulation, seen from its
overview camera with the on-screen panels hidden, cropped to the card's shape and saved as
web/public/thumbs/<site id>.jpg. A building without a picture keeps its line drawing on the card.

Needs Playwright (with Chromium) and Pillow, the website running locally against an API that has the buildings:
    python -m uvicorn nikaas.api:app --port 8000
    cd web && VITE_API_URL=http://localhost:8000 npx vite --port 5175
    python scripts/card_pictures.py museum office            # or no ids: every building the API lists
"""
import io
import json
import sys
import urllib.request
from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright

WEB, API = "http://localhost:5175", "http://localhost:8000"
OUT = Path(__file__).resolve().parents[1] / "web" / "public" / "thumbs"
VIEW = (1200, 800)  # render size; the crop below keeps the card's 1.93 : 1 shape
# where the building sits in the overview render (left, top, right, bottom); others get a centre crop
CROP = {"museum": (100, 230, 1100, 750), "office": (0, 140, 1200, 762), "tirupati-2": (20, 170, 1180, 771)}
SIZE = (760, 394)  # twice the card picture's size on screen

ids = sys.argv[1:] or [s["id"] for s in json.load(urllib.request.urlopen(f"{API}/sites"))]
OUT.mkdir(parents=True, exist_ok=True)
with sync_playwright() as p:
    browser = p.chromium.launch(args=["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"])
    page = browser.new_page(viewport={"width": VIEW[0], "height": VIEW[1]})
    for sid in ids:
        page.goto(f"{WEB}/#/sim?site={sid}", wait_until="networkidle")
        page.wait_for_timeout(4000)
        # a still camera: automatic camera off, then the overview
        page.evaluate("""() => {
          const btn = t => [...document.querySelectorAll('.sim3d button')].find(b => b.textContent.trim() === t)
          const auto = btn('Auto camera'); if (auto && auto.classList.contains('on')) auto.click()
          btn('Overview')?.click()
        }""")
        page.wait_for_timeout(3000)
        page.add_style_tag(content=".sim3d > :not(.d-stage) { display: none !important; }")
        page.wait_for_timeout(800)
        shot = Image.open(io.BytesIO(page.screenshot())).convert("RGB")
        w, h = VIEW
        box = CROP.get(sid, (100, int(h / 2 - 260), 1100, int(h / 2 + 260)))
        shot.crop(box).resize(SIZE, Image.LANCZOS).save(OUT / f"{sid}.jpg", "JPEG", quality=84, optimize=True, progressive=True)
        print(OUT / f"{sid}.jpg")
    browser.close()
