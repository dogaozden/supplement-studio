"""Small text helpers shared by the USLM and eCFR parsers."""
from __future__ import annotations
import re

# --- footnote markers -----------------------------------------------------
# Footnote reference spots in running text are written as Unicode superscript
# digits ("¹", "⁷⁷"); the footnote paragraph (a `p` node with role "footnote")
# starts with the same marker followed by a space. Unlike <sup> markup these
# survive both reader renderers untouched (they HTML-escape all text), are
# invisible to annotation-anchor logic (just characters), and can be turned
# into real <sup> by the PDF composer with one regex (FOOTNOTE_MARK_RE).
# EB Garamond (regular/medium/semibold) has the glyphs.
_SUPER = str.maketrans("0123456789", "⁰¹²³⁴⁵⁶⁷⁸⁹")
FOOTNOTE_MARK_RE = re.compile("[⁰¹²³⁴-⁹]+")


def superscript(digits: str) -> str:
    """'77' -> '⁷⁷' (non-digits are dropped)."""
    return "".join(ch for ch in digits if ch.isdigit()).translate(_SUPER)


# --- title casing ---------------------------------------------------------
_SMALL = {"a", "an", "and", "as", "at", "by", "for", "in", "of", "on", "or", "the", "to", "with"}


def _cap(word: str) -> str:
    return word[:1].upper() + word[1:].lower()


def smart_title(text: str, acronyms=()) -> str:
    """Title-case an ALL-CAPS (or all-lowercase) heading: small words stay
    lowercase (except first), tokens listed in `acronyms` stay uppercase,
    one-letter hyphen/dash segments stay uppercase ("S-K"), and digits are
    untouched. Mixed-case input is returned unchanged."""
    text = " ".join(text.split())
    if not text or (text != text.upper() and text != text.lower()):
        return text
    keep = {a.upper() for a in acronyms}
    out: list[str] = []
    for i, word in enumerate(text.split(" ")):
        # split off leading/trailing punctuation so "(ATS)," still matches
        m = re.match(r"^([^\w]*)(.*?)([^\w]*)$", word)
        lead, core, trail = m.groups() if m else ("", word, "")
        if core.upper() in keep:
            core = core.upper()
        elif re.fullmatch(r"[A-Za-z]\.?(?:[A-Za-z]\.)+", core):  # U.S.
            core = core.upper()
        elif re.search(r"[-–—]", core):
            segs = re.split(r"([-–—])", core)
            core = "".join(
                s if s in "-–—" else (s.upper() if len(s) == 1 or s.upper() in keep else _cap(s))
                for s in segs
            )
        elif core.lower() in _SMALL and i > 0:
            core = core.lower()
        else:
            core = _cap(core)
        out.append(lead + core + trail)
    s = " ".join(out)
    # a word after an em dash starts a new clause: capitalize it
    s = re.sub(r"(—)([a-z])", lambda m: m.group(1) + m.group(2).upper(), s)
    return s
