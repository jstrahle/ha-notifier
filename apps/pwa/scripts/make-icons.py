#!/usr/bin/env python3
"""
Regenerate the app icons from icon.svg.

    cd apps/pwa && npm run icons

Why a script rather than hand-exported files: the icon is needed at several
sizes, and iOS in particular is fussy about two things that are easy to get
wrong by hand —

  * apple-touch-icon must be 180x180 and must NOT be transparent. iOS composites
    a transparent home-screen icon onto black, which reads as a rendering bug.
    We therefore flatten every icon onto an opaque background.

  * iOS rounds the corners itself. A pre-rounded icon ends up double-rounded,
    with visible dark corners. So the source art is deliberately full-bleed and
    square.

To use your own artwork: replace icon.svg (keep the 512x512 viewBox) and re-run.
A PNG source works too — see PNG_SOURCE below.
"""

from pathlib import Path

import cairosvg
from PIL import Image

HERE = Path(__file__).resolve().parent.parent
SVG_SOURCE = HERE / "icon.svg"
# If you would rather drop in a ready-made square PNG, put it here and it will
# be used instead of the SVG.
PNG_SOURCE = HERE / "icon.png"
OUT_DIR = HERE / "public" / "icons"

# Background used to flatten any transparency. Matches the icon's own backdrop
# so a transparent source still looks intentional rather than clipped.
FLATTEN_BG = (55, 48, 163)  # #3730a3

SIZES = {
    "180.png": 180,  # apple-touch-icon — iOS home screen
    "192.png": 192,  # PWA manifest (Android launcher)
    "512.png": 512,  # PWA manifest (splash screens, stores)
}


def load_master() -> Image.Image:
    if PNG_SOURCE.exists():
        print(f"Using {PNG_SOURCE.name} as the source.")
        return Image.open(PNG_SOURCE).convert("RGBA")

    if not SVG_SOURCE.exists():
        raise SystemExit(f"No icon source found: expected {SVG_SOURCE} or {PNG_SOURCE}")

    print(f"Rendering {SVG_SOURCE.name} at 1024x1024...")
    png_bytes = cairosvg.svg2png(
        url=str(SVG_SOURCE), output_width=1024, output_height=1024
    )
    from io import BytesIO

    return Image.open(BytesIO(png_bytes)).convert("RGBA")


def flatten(img: Image.Image) -> Image.Image:
    """Composite onto an opaque background — iOS will not do this for us."""
    bg = Image.new("RGBA", img.size, FLATTEN_BG + (255,))
    return Image.alpha_composite(bg, img).convert("RGB")


def main() -> None:
    master = flatten(load_master())
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    for name, size in SIZES.items():
        out = OUT_DIR / name
        master.resize((size, size), Image.LANCZOS).save(out, "PNG", optimize=True)
        print(f"  wrote {out.relative_to(HERE)}  ({size}x{size})")

    print("\nDone. Rebuild the PWA, then see docs: changing an installed PWA's")
    print("icon on iOS requires removing it from the Home Screen and re-adding it.")


if __name__ == "__main__":
    main()
