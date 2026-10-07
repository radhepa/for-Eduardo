# Draws the Crow app icons (PNG) with Pillow: python tools/make_icons.py
# Same mascot as web/js/crow-art.js, drawn at 4x and scaled down for smooth edges.
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "web" / "icons"
OUT.mkdir(parents=True, exist_ok=True)
BODY, INK, BEAK = (27, 25, 34, 255), (247, 243, 234, 255), (255, 179, 71, 255)
BG_TOP, BG_BOT = (255, 197, 101), (240, 140, 26)


def gradient(size):
    img = Image.new("RGBA", (size, size))
    d = ImageDraw.Draw(img)
    for y in range(size):
        t = y / (size - 1)
        c = tuple(round(BG_TOP[i] + (BG_BOT[i] - BG_TOP[i]) * t) for i in range(3)) + (255,)
        d.line([(0, y), (size, y)], fill=c)
    return img


def crow(d, ox, oy, s):
    """Draw the mascot in a 100x100 box at (ox, oy), scale s px per unit."""
    P = lambda x, y: (ox + x * s, oy + y * s)
    E = lambda cx, cy, rx, ry: [ox + (cx - rx) * s, oy + (cy - ry) * s, ox + (cx + rx) * s, oy + (cy + ry) * s]
    d.polygon([P(45, 18), P(44, 9), P(49, 4), P(55, 2), P(52, 8), P(53, 12), P(57, 17)], fill=BODY)
    d.polygon([P(52, 18), P(55, 11), P(61, 9), P(66, 9), P(61, 12), P(60, 15), P(61, 19)], fill=BODY)
    d.ellipse(E(50, 56, 39, 37), fill=BODY)
    d.polygon([P(14, 66), P(6, 70), P(5, 78), P(9, 84), P(13, 79), P(17, 76), P(22, 75)], fill=BODY)
    d.polygon([P(86, 66), P(94, 70), P(95, 78), P(91, 84), P(87, 79), P(83, 76), P(78, 75)], fill=BODY)
    for cx, dx in ((35, 1.5), (65, -1.5)):
        d.ellipse(E(cx, 50, 11, 11), fill=INK)
        d.ellipse(E(cx + dx, 51.5, 5, 5), fill=BODY)
    d.polygon([P(41, 62), P(59, 62), P(50, 75)], fill=BEAK)
    w = max(1, round(3 * s))
    for fx in (40, 60):
        for ex in (-5, 0, 5):
            d.line([P(fx, 92), P(fx + ex, 98)], fill=BEAK, width=w)


def icon(size, maskable=False):
    big = size * 4
    img = gradient(big)
    if not maskable:
        mask = Image.new("L", (big, big), 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, big - 1, big - 1], radius=round(big * 0.22), fill=255)
        img.putalpha(mask)
    d = ImageDraw.Draw(img)
    inner = 0.62 if maskable else 0.8          # maskable icons keep art inside the 80% safe zone
    s = big * inner / 100
    ox = (big - 100 * s) / 2
    oy = (big - 100 * s) / 2 - big * 0.015
    crow(d, ox, oy, s)
    return img.resize((size, size), Image.LANCZOS)


icon(192).save(OUT / "icon-192.png")
icon(512).save(OUT / "icon-512.png")
icon(512, maskable=True).save(OUT / "icon-maskable-512.png")
icon(64).save(OUT / "icon-64.png")

svg = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffc565"/><stop offset="1" stop-color="#f08c1a"/></linearGradient></defs>
<rect width="100" height="100" rx="22" fill="url(#g)"/>
<g transform="translate(10 11) scale(.8)">
<path d="M45 18 C44 9 49 4 55 2 C52 8 53 12 57 17 Z" fill="#1b1922"/>
<path d="M52 18 C55 11 61 9 66 9 C61 12 60 15 61 19 Z" fill="#1b1922"/>
<ellipse cx="50" cy="56" rx="39" ry="37" fill="#1b1922"/>
<path d="M14 66 C6 70 5 78 9 84 C13 79 17 76 22 75 Z" fill="#1b1922"/>
<path d="M86 66 C94 70 95 78 91 84 C87 79 83 76 78 75 Z" fill="#1b1922"/>
<circle cx="35" cy="50" r="11" fill="#f7f3ea"/><circle cx="36.5" cy="51.5" r="5" fill="#1b1922"/>
<circle cx="65" cy="50" r="11" fill="#f7f3ea"/><circle cx="63.5" cy="51.5" r="5" fill="#1b1922"/>
<path d="M41 62 L59 62 L50 75 Z" fill="#ffb347"/>
<g stroke="#ffb347" stroke-width="3" stroke-linecap="round" fill="none"><path d="M40 92 v6 M40 92 l-5 6 M40 92 l5 6"/><path d="M60 92 v6 M60 92 l-5 6 M60 92 l5 6"/></g>
</g></svg>
"""
(OUT / "icon.svg").write_text(svg, encoding="utf-8")
print("icons written to", OUT)
