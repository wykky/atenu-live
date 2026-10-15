"""
Builds the Atenu Live app icons: the Atenu "atn" monogram with QUIZ beneath,
yellow on black, matching the atenu.org site icon.

Inputs (this folder):
  atn-mask.png       alpha mask of the "atn" script, cut from the 1920px brand
                     master (video-scripts/_anim-kit/assets/brand/
                     atenu-monogram-atn-RASTER.svg)
  montserrat-800.ttf Montserrat ExtraBold (OFL), for "QUIZ"

Run from the repo root:  python3 scripts/pwa-icons/build.py
Writes public/pwa/*.png, src/app/icon.png, src/app/apple-icon.png,
src/app/favicon.ico.
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).parent
ROOT = HERE.parent.parent
YELLOW = (255, 218, 7)   # the monogram's own yellow
BLACK = (0, 0, 0)
SS = 4                   # supersample factor for smooth edges

MASK = Image.open(HERE / "atn-mask.png").convert("L")
FONT = HERE / "montserrat-800.ttf"


def mark(canvas, box_w, cx, cy, with_quiz=True):
    """Draw atn (+ QUIZ) centred on (cx, cy), atn box_w pixels wide."""
    atn_h = round(box_w * MASK.height / MASK.width)
    atn = MASK.resize((box_w, atn_h), Image.LANCZOS)
    if not with_quiz:
        canvas.paste(YELLOW, (cx - box_w // 2, cy - atn_h // 2), atn)
        return
    font = ImageFont.truetype(str(FONT), round(box_w * 0.235))
    word, track = "QUIZ", round(box_w * 0.07)
    draw = ImageDraw.Draw(canvas)
    widths = [draw.textbbox((0, 0), ch, font=font)[2] for ch in word]
    text_w = sum(widths) + track * (len(word) - 1)
    top, bottom = draw.textbbox((0, 0), "QUIZ", font=font)[1::2]
    cap_h = bottom - top
    gap = round(box_w * 0.07)
    total = atn_h + gap + cap_h
    y0 = cy - total // 2
    canvas.paste(YELLOW, (cx - box_w // 2, y0), atn)
    x = cx - text_w // 2
    ty = y0 + atn_h + gap - top
    for ch, w in zip(word, widths):
        draw.text((x, ty), ch, font=font, fill=YELLOW)
        x += w + track


def icon(size, *, scale, rounded, with_quiz=True):
    big = size * SS
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    if rounded:
        ImageDraw.Draw(img).rounded_rectangle((0, 0, big - 1, big - 1), radius=round(big * 0.22), fill=BLACK)
    else:
        img.paste(BLACK, (0, 0, big, big))
    mark(img, round(big * scale), big // 2, big // 2, with_quiz)
    return img.resize((size, size), Image.LANCZOS)


out = ROOT / "public" / "pwa"
out.mkdir(parents=True, exist_ok=True)
# "any": rounded black tile, mark fills it.
icon(192, scale=0.74, rounded=True).save(out / "icon-192.png", optimize=True)
icon(512, scale=0.74, rounded=True).save(out / "icon-512.png", optimize=True)
# "maskable": full-bleed, mark inside the 80% safe-zone circle.
icon(512, scale=0.56, rounded=False).save(out / "maskable-512.png", optimize=True)
# Favicon PNG and apple-touch-icon (iOS rounds corners itself, so square).
icon(192, scale=0.74, rounded=True).save(ROOT / "src/app/icon.png", optimize=True)
icon(180, scale=0.74, rounded=False).convert("RGB").save(ROOT / "src/app/apple-icon.png", optimize=True)
# Tiny tab favicon: QUIZ is unreadable at 16-32px, so atn alone.
fav = icon(64, scale=0.86, rounded=True, with_quiz=False)
fav.save(ROOT / "src/app/favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])
print("icons written")
