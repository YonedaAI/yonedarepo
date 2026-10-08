"""Readable titles and framing around real screenshots; never redraw the UI."""

from pathlib import Path
import textwrap
from PIL import Image, ImageDraw, ImageFont, ImageOps

SIZE = (1920, 1080)
BG, INK, MUTED, ACCENT = "#0b1120", "#f0f5fc", "#a8bbd1", "#79c7e2"


def font(size, bold=False):
    choices = [
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf" if bold else
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]
    for name in choices:
        if Path(name).is_file():
            return ImageFont.truetype(name, size)
    raise ValueError("Install Arial or DejaVu Sans for video assembly")


def text(draw, value, xy, size=32, width=90, fill=INK, bold=False):
    x, y = xy
    for line in textwrap.wrap(value, width=width):
        draw.text((x, y), line, font=font(size, bold), fill=fill)
        y += size + 12
    return y


def base(scene, label):
    canvas = Image.new("RGB", SIZE, BG)
    draw = ImageDraw.Draw(canvas)
    draw.rectangle((0, 0, 1920, 5), fill=ACCENT)
    text(draw, f"YONEDAREPO   /   {scene['id']}   /   {label.upper()}",
         (62, 28), size=20, fill=ACCENT, width=140)
    text(draw, scene["title"], (62, 66), size=43, width=82, bold=True)
    draw.line((62, 996, 1858, 996), fill="#25364c", width=2)
    text(draw, "AI presenter and voice  |  Actual captures and evidence  |  Edited walkthrough",
         (62, 1015), size=22, width=145, fill=MUTED)
    return canvas, draw


def screenshot(scene, source, target, label="Actual product capture", crop=None):
    canvas, draw = base(scene, label)
    image = Image.open(source).convert("RGB")
    if crop:
        image = image.crop(tuple(crop))
    image = ImageOps.contain(image, (1796, 815), Image.Resampling.LANCZOS)
    left, top = (1920-image.width)//2, 153+(815-image.height)//2
    canvas.paste(image, (left, top))
    canvas.save(target, quality=95)


def rows(scene, entries, target, label="Recorded evidence"):
    canvas, draw = base(scene, label)
    gap = min(148, 770 // max(1, len(entries)))
    for i, (title, detail) in enumerate(entries):
        y = 175+i*gap
        draw.rounded_rectangle((62, y, 1858, y+gap-16), radius=14,
                               fill="#142238", outline="#304660", width=2)
        text(draw, title, (90, y+17), size=34, bold=True, width=92)
        text(draw, detail, (90, y+65), size=27, fill=MUTED, width=113)
    canvas.save(target, quality=95)


def presenter_overlay(scene, target):
    canvas = Image.new("RGBA", SIZE, (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)
    # Keep the lower picture clear for native video captions and controls.
    draw.rounded_rectangle((56, 40, 620, 172), radius=14,
                           fill=(11, 17, 32, 220))
    text(draw, "YonedaRepo", (82, 58), size=38, bold=True, width=40)
    text(draw, "AI presenter and owner voice", (82, 114), size=25,
         width=50, fill=ACCENT)
    canvas.save(target)
