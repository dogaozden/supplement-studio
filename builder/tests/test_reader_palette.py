"""The student reader's five highlight inks stay legible and distinguishable.

Reads the tokens straight out of builder/reader/template/reader.css, in both
themes, and checks the three things the design round asked for:
  * body ink on any highlight wash (resting and hovered) clears WCAG AA (4.5:1);
  * each ink is at least 3:1 against paper and card surface (ticks, dots, rules
    and the colour chips are non-text parts of the interface);
  * the five washes and the five inks are far enough apart to tell apart.
"""
import itertools
import math
import re
from pathlib import Path

import pytest

CSS = (Path(__file__).resolve().parents[1] / "reader" / "template" / "reader.css").read_text()
HUES = ["yellow", "green", "blue", "purple", "orange"]


def block(opener):
    m = re.search(re.escape(opener) + r"\s*\{(.*?)\n\}", CSS, re.S)
    assert m, opener
    return m.group(1)


def hexrgb(s):
    s = s.lstrip("#")
    return tuple(int(s[i:i + 2], 16) for i in (0, 2, 4))


def tokens(theme):
    root = block(":root")
    body = root if theme == "light" else root + "\n" + block('html[data-theme="dark"]')

    def last(name):  # later declarations win, as in the cascade
        return re.findall(rf"--{name}:\s*([^;]+);", body)[-1].strip()

    hues = {h: tuple(int(x) for x in last(f"hl-{h}").split(",")) for h in HUES}
    return {
        "paper": hexrgb(last("paper")),
        "surface": hexrgb(last("surface")),
        "ink": hexrgb(last("ink")),
        "wash": float(last("hl-wash")),
        "hover": float(last("hl-wash-hover")),
        "hues": hues,
    }


def lin(c):
    c /= 255
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def lum(rgb):
    r, g, b = (lin(x) for x in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a, b):
    la, lb = sorted((lum(a), lum(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


def over(fg, bg, alpha):
    return tuple(round(f * alpha + b * (1 - alpha)) for f, b in zip(fg, bg))


def lab(rgb):
    r, g, b = (lin(x) for x in rgb)
    x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047
    y = 0.2126 * r + 0.7152 * g + 0.0722 * b
    z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883

    def f(t):
        return t ** (1 / 3) if t > 0.008856 else 7.787 * t + 16 / 116
    return (116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z)))


def delta_e(a, b):
    return math.dist(lab(a), lab(b))


@pytest.mark.parametrize("theme", ["light", "dark"])
def test_ink_is_readable_on_every_wash(theme):
    t = tokens(theme)
    for hue, rgb in t["hues"].items():
        for alpha in (t["wash"], t["hover"]):
            wash = over(rgb, t["paper"], alpha)
            ratio = contrast(t["ink"], wash)
            assert ratio >= 4.5, f"{theme} {hue} wash at {alpha}: ink contrast {ratio:.2f}"


@pytest.mark.parametrize("theme", ["light", "dark"])
def test_inks_clear_non_text_contrast_on_paper_and_surface(theme):
    t = tokens(theme)
    for hue, rgb in t["hues"].items():
        for ground in ("paper", "surface"):
            ratio = contrast(rgb, t[ground])
            assert ratio >= 3.0, f"{theme} {hue} on {ground}: {ratio:.2f}"


@pytest.mark.parametrize("theme", ["light", "dark"])
def test_five_hues_are_distinguishable(theme):
    t = tokens(theme)
    washes = {h: over(rgb, t["paper"], t["wash"]) for h, rgb in t["hues"].items()}
    for a, b in itertools.combinations(HUES, 2):
        assert delta_e(washes[a], washes[b]) >= 12, f"{theme} washes {a}/{b} look alike"
        assert delta_e(t["hues"][a], t["hues"][b]) >= 30, f"{theme} inks {a}/{b} look alike"
