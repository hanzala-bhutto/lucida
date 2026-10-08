"""
Render the README hero banner: the Lucida icon + wordmark + tagline + feature
pills on the brand gradient.

Run: python scratch/make_hero.py   (needs Pillow and numpy; Segoe UI from Windows)
Writes docs/hero.png (1600x520). Uses the icon from make_icon.py when it has
been rendered, else src-tauri/icons/icon.png.
"""
import os
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
FONTS = Path(os.environ.get("WINDIR", r"C:\Windows")) / "Fonts"
SCALE = 2
W, H = 1600 * SCALE, 520 * SCALE

TAGLINE = "A whiteboard for Windows: pictures, plans, agents."
PILLS = ["Pictures from a word", "Board per folder", "Plan wall in Markdown", "MCP"]


def load_font(size, bold=False):
    for name in (["segoeuib.ttf", "arialbd.ttf"] if bold else ["segoeui.ttf", "arial.ttf"]):
        try:
            return ImageFont.truetype(str(FONTS / name), size)
        except OSError:
            continue
    return ImageFont.load_default()


def diagonal_gradient(w, h, c0, c1):
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    t = (xx / w * 0.6 + yy / h * 0.4)
    arr = np.empty((h, w, 4), dtype=np.uint8)
    for i in range(3):
        arr[..., i] = (c0[i] + (c1[i] - c0[i]) * t).astype(np.uint8)
    arr[..., 3] = 255
    return Image.fromarray(arr, "RGBA")


def icon_source():
    rendered = Path(tempfile.gettempdir()) / "lucida-icon.png"
    return rendered if rendered.exists() else ROOT / "src-tauri" / "icons" / "icon.png"


def render():
    img = diagonal_gradient(W, H, (79, 70, 229), (124, 58, 237))  # indigo-600 -> violet-600

    # Icon with a soft shadow.
    size = 270 * SCALE
    icon = Image.open(icon_source()).convert("RGBA").resize((size, size), Image.LANCZOS)
    ix, iy = int(W * 0.064), int(H / 2 - size / 2)
    shadow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    shadow.paste((0, 0, 0, 90), (ix + 6 * SCALE, iy + 12 * SCALE), icon.split()[3])
    img = Image.alpha_composite(img, shadow.filter(ImageFilter.GaussianBlur(18)))
    img.paste(icon, (ix, iy), icon)
    d = ImageDraw.Draw(img)

    # Wordmark + tagline.
    white = (255, 255, 255, 255)
    tx = ix + size + 80 * SCALE
    d.text((tx, H * 0.20), "Lucida", font=load_font(132 * SCALE, bold=True), fill=white)
    d.text((tx + 2 * SCALE, H * 0.53), TAGLINE, font=load_font(32 * SCALE), fill=(255, 255, 255, 240))

    # Feature pills, drawn on an alpha-composited overlay so the translucent
    # fill actually blends (plain ImageDraw on an RGBA image overwrites alpha).
    pills = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    pd = ImageDraw.Draw(pills)
    f_pill = load_font(23 * SCALE, bold=True)
    px, py = tx - 4 * SCALE, int(H * 0.70)
    for label in PILLS:
        bb = pd.textbbox((0, 0), label, font=f_pill)
        tw, th = bb[2] - bb[0], bb[3] - bb[1]
        pad_x, pad_y = 20 * SCALE, 17 * SCALE
        h_pill = th + 2 * pad_y
        pd.rounded_rectangle([px, py, px + tw + 2 * pad_x, py + h_pill], radius=h_pill // 2,
                             fill=(255, 255, 255, 50))
        pd.text((px + pad_x, py + pad_y - bb[1]), label, font=f_pill, fill=white)
        px += tw + 2 * pad_x + 16 * SCALE
    img = Image.alpha_composite(img, pills)

    out = ROOT / "docs" / "hero.png"
    img.convert("RGB").resize((1600, 520), Image.LANCZOS).save(out)
    print(f"wrote {out}")


if __name__ == "__main__":
    render()
