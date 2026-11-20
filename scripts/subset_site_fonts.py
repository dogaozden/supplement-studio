#!/usr/bin/env python3
"""Subset the landing page's EB Garamond faces to Latin.

Dev-time tool (needs fontTools + brotli, e.g. builder/.venv); the Pages
build never runs it. The full faces live in builder/assets/fonts/ (the
studio uses them as they are); this writes lean copies to
site/assets/fonts/ so the landing page ships ~100 KB of type, not ~1.3 MB.

Kept OpenType features: kerning, ligatures, small caps (smcp, c2sc),
old-style / lining / tabular / proportional figures (onum, lnum, tnum,
pnum), case-sensitive forms. EB Garamond is under the SIL Open Font
License; the license text stays in the font's name table.

  builder/.venv/bin/python3 scripts/subset_site_fonts.py
"""
from pathlib import Path

from fontTools import subset

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "builder" / "assets" / "fonts"
DST = ROOT / "site" / "assets" / "fonts"

FACES = [
    "EBGaramond-Regular",
    "EBGaramond-Italic",
    "EBGaramond-Medium",
    "EBGaramond-MediumItalic",
]

# Basic Latin, Latin-1, Latin Extended-A (names), general punctuation,
# section/paragraph signs, currency, minus, trademark.
UNICODES = (
    list(range(0x20, 0x7F))
    + list(range(0xA0, 0x100))
    + list(range(0x100, 0x180))
    + [0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2018, 0x2019, 0x201A,
       0x201C, 0x201D, 0x201E, 0x2020, 0x2021, 0x2022, 0x2026, 0x2032,
       0x2033, 0x20AC, 0x2122, 0x2212, 0x2009, 0x200A, 0x202F, 0x2002, 0x2003]
)
FEATURES = ["kern", "liga", "clig", "calt", "locl", "smcp", "c2sc", "onum",
            "lnum", "tnum", "pnum", "case", "ccmp", "mark", "mkmk"]


def main() -> None:
    DST.mkdir(parents=True, exist_ok=True)
    options = subset.Options()
    options.flavor = "woff2"
    options.layout_features = FEATURES
    options.hinting = False
    options.desubroutinize = True
    options.notdef_outline = True
    options.name_IDs = [0, 1, 2, 3, 4, 5, 6, 13, 14]
    for face in FACES:
        font = subset.load_font(str(SRC / f"{face}.woff2"), options)
        subsetter = subset.Subsetter(options)
        subsetter.populate(unicodes=UNICODES)
        subsetter.subset(font)
        out = DST / f"{face}.woff2"
        subset.save_font(font, str(out), options)
        print(f"{out.relative_to(ROOT)}  {out.stat().st_size:,} bytes")


if __name__ == "__main__":
    main()
