#!/usr/bin/env python3
"""
Randsight icon.

The mark is the panel's own probability bars, narrowing top to bottom: the
first is settled, the rest taper toward doubt. Read as a silhouette it is a
wedge — possibilities being narrowed, which is the product in one shape.

Drawn at 8x and downsampled; rounded caps and a rounded-square mask alias
badly if drawn at 16px directly.
"""
from PIL import Image, ImageDraw

S = 1024

VARIANTS = {
    # dark panel ground, with a rim so it still separates on a dark toolbar
    "slate": {
        "bg": (23, 27, 34, 255),
        "rim": (86, 99, 122, 255),
        "bars": [(110, 231, 165, 255), (143, 188, 255, 255), (96, 122, 165, 255)],
    },
    # accent ground: highest contrast on both light and dark toolbars
    "blue": {
        "bg": (26, 76, 156, 255),
        "rim": None,
        "bars": [(255, 255, 255, 255), (168, 205, 255, 255), (104, 148, 214, 255)],
    },
}

# Less extreme taper than the first pass: the third bar has to still read as a
# bar. At 0.26 of the width it collapsed into a dot and the whole mark looked
# like a bulleted list.
WIDTHS = (0.78, 0.56, 0.36)


def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size - 1, size - 1], radius, fill=255)
    return m


def render(size_out, v):
    spec = VARIANTS[v]
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    r = int(S * 0.22)
    d.rounded_rectangle([0, 0, S - 1, S - 1], radius=r, fill=spec["bg"])
    if spec["rim"]:
        d.rounded_rectangle([0, 0, S - 1, S - 1], radius=r,
                            outline=spec["rim"], width=int(S * 0.022))

    pad = S * 0.155
    inner = S - pad * 2
    bar_h = S * 0.148
    gap = S * 0.077
    total = bar_h * 3 + gap * 2
    y = (S - total) / 2

    for colour, frac in zip(spec["bars"], WIDTHS):
        w = inner * frac
        d.rounded_rectangle([pad, y, pad + w, y + bar_h], radius=bar_h / 2, fill=colour)
        y += bar_h + gap

    img.putalpha(rounded_mask(S, r))
    return img.resize((size_out, size_out), Image.LANCZOS)


if __name__ == "__main__":
    import sys
    out = sys.argv[1] if len(sys.argv) > 1 else "."
    which = sys.argv[2] if len(sys.argv) > 2 else "slate"
    for n in (16, 32, 48, 128):
        render(n, which).save(f"{out}/icon{n}.png")
    render(512, which).save(f"{out}/icon512.png")
    print(f"wrote {which}: 16 / 32 / 48 / 128 / 512")
