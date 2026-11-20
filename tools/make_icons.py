"""Generate PNG app icons (run once: python tools/make_icons.py)."""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent


def icon(size: int) -> Image.Image:
    s = size / 512
    img = Image.new("RGB", (size, size), (12, 11, 9))
    d = ImageDraw.Draw(img)
    # glowing disc
    d.ellipse([60 * s, 60 * s, 452 * s, 452 * s], fill=(22, 19, 15), outline=(216, 172, 99), width=max(2, int(8 * s)))
    # eighth notes
    brass = (216, 172, 99)
    d.ellipse([150 * s, 300 * s, 230 * s, 365 * s], fill=brass)
    d.ellipse([290 * s, 270 * s, 370 * s, 335 * s], fill=brass)
    w = int(22 * s)
    d.rectangle([208 * s, 160 * s, 208 * s + w, 335 * s], fill=brass)
    d.rectangle([348 * s, 130 * s, 348 * s + w, 305 * s], fill=brass)
    d.polygon([(208 * s, 160 * s), (370 * s, 130 * s), (370 * s, 180 * s), (208 * s, 210 * s)], fill=brass)
    return img


for n in (192, 512):
    icon(n).save(ROOT / f"icon-{n}.png")
print("ok")
