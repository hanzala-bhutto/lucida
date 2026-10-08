"""
Render the Lucida app icon: a premium gradient squircle with a geometric glyph
that reads as "shapes + clarity" — a clean rounded square interlocking with a
circle, plus a small AI sparkle. Rendered at 2x and downsampled for crisp edges.

Run: python scratch/make_icon.py   (needs Pillow and numpy)
Outputs lucida-icon.png (1024) + small previews in %TEMP%; regenerate the app
icons from it with `npm run tauri icon %TEMP%\lucida-icon.png`.
"""
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageChops

SCALE = 2
S = 1024 * SCALE


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def diagonal_gradient(size, c0, c1):
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
    t = (xx + yy) / (2 * (size - 1))
    arr = np.empty((size, size, 4), dtype=np.uint8)
    for i in range(3):
        arr[..., i] = (c0[i] + (c1[i] - c0[i]) * t).astype(np.uint8)
    arr[..., 3] = 255
    return Image.fromarray(arr, "RGBA")


def squircle_mask(size, pad, radius):
    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([pad, pad, size - 1 - pad, size - 1 - pad], radius=radius, fill=255)
    return m


def four_point_star(cx, cy, r, waist):
    return [
        (cx, cy - r), (cx + waist, cy - waist), (cx + r, cy), (cx + waist, cy + waist),
        (cx, cy + r), (cx - waist, cy + waist), (cx - r, cy), (cx - waist, cy - waist),
    ]


def render():
    # Premium indigo -> violet gradient.
    c0 = (99, 102, 241)   # indigo-500
    c1 = (139, 92, 246)   # violet-500
    grad = diagonal_gradient(S, c0, c1)

    pad = int(S * 0.05)
    radius = int((S - 2 * pad) * 0.235)
    mask = squircle_mask(S, pad, radius)

    icon = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    icon.paste(grad, (0, 0), mask)

    # Subtle top sheen for depth — a smooth vertical fade (no hard edge),
    # clipped to the squircle so it reads as light catching the top.
    yy = np.mgrid[0:S, 0:S][0].astype(np.float32)
    top, bot = float(pad), 0.62 * S
    fade = np.clip(1.0 - (yy - top) / (bot - top), 0.0, 1.0) ** 1.4
    sheen_alpha = Image.fromarray((fade * 32).astype(np.uint8), "L")
    sheen_alpha = ImageChops.multiply(sheen_alpha, mask)
    icon = Image.composite(Image.new("RGBA", (S, S), (255, 255, 255, 255)), icon, sheen_alpha)

    d = ImageDraw.Draw(icon)
    white = (255, 255, 255, 255)
    soft = (255, 255, 255, 235)
    w = int(S * 0.034)

    # Clean rounded square (top-left) interlocking with a circle (bottom-right).
    g = 0.355 * S          # glyph element size
    sq_c = (0.435 * S, 0.435 * S)
    ci_c = (0.585 * S, 0.585 * S)
    sq = [sq_c[0] - g / 2, sq_c[1] - g / 2, sq_c[0] + g / 2, sq_c[1] + g / 2]
    ci = [ci_c[0] - g / 2, ci_c[1] - g / 2, ci_c[0] + g / 2, ci_c[1] + g / 2]
    d.rounded_rectangle(sq, radius=int(g * 0.17), outline=soft, width=w)
    d.ellipse(ci, outline=white, width=w)

    # AI sparkle, top-right of the glyph.
    sx, sy = 0.715 * S, 0.315 * S
    d.polygon(four_point_star(sx, sy, 0.075 * S, 0.018 * S), fill=white)
    d.polygon(four_point_star(0.80 * S, 0.45 * S, 0.032 * S, 0.008 * S), fill=soft)

    out = icon.resize((1024, 1024), Image.LANCZOS)
    tmp = Path(tempfile.gettempdir())
    out.save(tmp / "lucida-icon.png")
    out.resize((128, 128), Image.LANCZOS).save(tmp / "lucida-icon-128.png")
    out.resize((32, 32), Image.LANCZOS).save(tmp / "lucida-icon-32.png")
    print(f"wrote {tmp / 'lucida-icon.png'} (+128,32 previews)")


if __name__ == "__main__":
    render()
