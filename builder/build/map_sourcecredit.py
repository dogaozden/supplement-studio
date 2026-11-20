"""Parse the first (enacting) citation from a USLM sourceCredit string.

sourceCredit examples:
    (May 27, 1933, ch. 38, title I, § 1, 48 Stat. 74.)
    (Pub. L. 112–106, title III, § 301, Apr. 5, 2012, 126 Stat. 315.)
    (May 27, 1933, ch. 38, title I, § 5, 48 Stat. 77; June 6, 1934, ch. 404, § 205, 48 Stat. 906.)
    (May 27, 1933, ch. 38, title I, § 2A, as added Pub. L. 106–554, ...)
    (May 27, 1933, ch. 38, title III, § 301, as added Aug. 3, 1939, ch. 411, 53 Stat. 1149.)
    (June 6, 1934, ch. 404, title I, § 21D, as added and amended Pub. L. 104–67, ...)
    (Pub. L. 91–598, § 1(a), Dec. 30, 1970, 84 Stat. 1636.)
    (Pub. L. 91–598, § 11, formerly § 7, Dec. 30, 1970, 84 Stat. 1652, 1653; ...)
    (May 27, 1933, ch. 38, title I, schedules A, B, 48 Stat. 88, 91; ...)

The original section number is only trustworthy when the *enacting* statute
is the act whose numbering we're reporting. A first citation naming some
other statute (a 1936 amendment act, Dodd-Frank's free-standing sections, the
FCPA…) is a different act's section number, so callers may pass
`statute_chapters` / `pub_laws` to restrict which enacting laws count; a
citation that doesn't match yields None rather than a wrong cite.
"""
from __future__ import annotations
import re
from typing import Any, Iterable, Mapping

from builder.build.corpus_config import default_config

_DATE = r"[A-Z][a-z]+\.?\s+\d+,\s+\d{4}"
# original section: "5", "21D", "2A", "77b" then optional "(a)(1)" subdivisions
# (the credit names the subdivision that was enacted; the section is the base)
_SEC = r"§\s*(?P<orig_sec>[\w–\-.]+?)(?:\([^)]*\))*"
_FORMERLY = r"(?:\s*,\s*formerly\s*§\s*[\w–\-.]+(?:\([^)]*\))*)?"
_TITLE = r"(?:\s*,\s*(?:div\.\s*[A-Z]+\s*,\s*)?title\s*(?P<title>[IVXLC]+))?"
_PL = r"(?P<pl>\d+[-–]\d+)"
_AS_ADDED_TAIL = r"\s*,\s*as\s+added(?:\s+and\s+amended)?\s+"

_OLD_STYLE = re.compile(
    rf"(?P<date>{_DATE})\s*,\s*ch\.\s*(?P<chap>\w+){_TITLE}\s*,\s*{_SEC}{_FORMERLY}"
    rf"\s*,\s*(?P<vol>\d+)\s+Stat\.\s+(?P<page>\d+)"
)

_PUBLAW_STYLE = re.compile(
    rf"^\s*Pub\.\s*L\.\s*{_PL}{_TITLE}\s*,\s*{_SEC}{_FORMERLY}"
    rf"(?:\s*,\s*(?P<date>{_DATE})\s*,\s*(?P<vol>\d+)\s+Stat\.\s+(?P<page>\d+)|{_AS_ADDED_TAIL})"
)

# Sections inserted by amending legislation: no Stat. cite directly after the §.
#   "§ 2A, as added Pub. L. 106-554, ..."               (added by a later public law)
#   "§ 301, as added Aug. 3, 1939, ch. 411, 53 Stat…"   (added by a later chapter act)
#   "§ 21D, as added and amended Pub. L. 104–67, ..."
_AS_ADDED = re.compile(
    rf"(?P<initial_date>{_DATE})\s*,\s*ch\.\s*(?P<chap>\w+){_TITLE}\s*,\s*{_SEC}{_FORMERLY}"
    rf"{_AS_ADDED_TAIL}(?:Pub\.\s*L\.\s*(?P<pl>\d+[-–]\d+)|{_DATE})"
)

# "ch. 38, title I, schedules A, B, 48 Stat. 88" — the Securities Act's schedules
_SCHEDULE_STYLE = re.compile(
    rf"(?P<date>{_DATE})\s*,\s*ch\.\s*(?P<chap>\w+){_TITLE}\s*,\s*"
    r"(?P<sched>schedules?\s+[A-Z](?:\s*(?:,|and)\s*[A-Z])*)\s*,\s*(?P<vol>\d+)\s+Stat\."
)


def first_citation(source_credit: str) -> str:
    """The first citation of a sourceCredit: from the opening '(' to the first
    ';' (or the closing ')' when there is only one citation). Subdivisions
    like '§ 1(a)' contain ')' themselves, so we can't stop at the first one."""
    s = source_credit.strip()
    if s.startswith("("):
        s = s[1:]
    s = s.split(";", 1)[0]
    s = s.rstrip()
    if s.endswith(")") and s.count("(") < s.count(")"):
        s = s[:-1]
    return s.rstrip(" .")


def _norm_pl(pl: str | None) -> str:
    return (pl or "").replace("–", "-")


def parse_source_credit(
    source_credit: str, usc_chapter: str | None = None
) -> dict[str, Any] | None:
    """Return dict with keys: date, chapter, title_roman (or None), orig_sec,
    stat_vol, stat_page, kind ('old', 'publaw', 'as_added' or 'schedule').
    Or None if no match."""
    head = first_citation(source_credit)
    if not head:
        return None

    # "as added" shapes first — they also start with a date+chapter.
    m = _AS_ADDED.search(head)
    if m:
        return {
            "kind": "as_added",
            "date": m.group("initial_date"),
            "chapter": m.group("chap"),
            "title_roman": m.group("title"),
            "orig_sec": m.group("orig_sec"),
            "stat_vol": None,
            "stat_page": None,
            "pub_law": m.group("pl"),
        }

    m = _SCHEDULE_STYLE.search(head)
    if m:
        sched = " ".join(m.group("sched").split())
        letters = re.findall(r"\b[A-Z]\b", sched[len("schedule"):])
        orig_sec = ("Schedule " if len(letters) == 1 else "Schedules ") + ", ".join(letters)
        return {
            "kind": "schedule",
            "date": m.group("date"),
            "chapter": m.group("chap"),
            "title_roman": m.group("title"),
            "orig_sec": orig_sec,
            "stat_vol": m.group("vol"),
            "stat_page": None,
        }

    m = _OLD_STYLE.search(head)
    if m:
        return {
            "kind": "old",
            "date": m.group("date"),
            "chapter": m.group("chap"),
            "title_roman": m.group("title"),
            "orig_sec": m.group("orig_sec"),
            "stat_vol": m.group("vol"),
            "stat_page": m.group("page"),
        }
    m = _PUBLAW_STYLE.search(head)
    if m:
        return {
            "kind": "publaw",
            "date": m.group("date"),
            "pub_law": m.group("pl"),
            "title_roman": m.group("title"),
            "orig_sec": m.group("orig_sec"),
            "stat_vol": m.group("vol"),
            "stat_page": m.group("page"),
        }
    return None


def original_for_section(
    source_credit: str, usc_chapter: str,
    act_names: Mapping[str, str] | None = None,
    *,
    act_name: str | None = None,
    statute_chapters: Iterable[str] | None = None,
    pub_laws: Iterable[str] | None = None,
) -> dict[str, str] | None:
    """Turn sourceCredit + chapter into {num, cite} for the original-act mode.
    E.g., s-77a in chapter 15/2A → {'num': '1', 'cite': 'Securities Act of 1933 § 1'}.

    `act_names` maps usc_chapter → act name (defaults to the securities corpus
    config); `act_name` overrides that lookup (used for acts split out of a
    chapter by subchapter). When `statute_chapters` (Statutes at Large chapter
    numbers, e.g. {"404"}) or `pub_laws` (e.g. {"91-598"}) are given, only a
    citation whose enacting statute is in one of them counts; any other first
    citation names a different act's section number, so → None.
    """
    parsed = parse_source_credit(source_credit, usc_chapter)
    if not parsed:
        return None
    if act_name is None:
        if act_names is None:
            act_names = default_config()["uslm"]["act_names"]
        act_name = act_names.get(usc_chapter)
    if not act_name:
        return None
    chapters = {str(c) for c in statute_chapters} if statute_chapters else None
    laws = {_norm_pl(p) for p in pub_laws} if pub_laws else None
    if chapters is not None or laws is not None:
        ok = False
        if parsed["kind"] in ("old", "as_added", "schedule") and parsed.get("chapter") is not None:
            ok = chapters is not None and parsed["chapter"] in chapters
        elif parsed["kind"] == "publaw":
            ok = laws is not None and _norm_pl(parsed["pub_law"]) in laws
        # an "as added Pub. L." continuation doesn't change the enacting
        # statute named first, so no further check
        if not ok:
            return None
    if parsed["kind"] == "schedule":
        return {"num": parsed["orig_sec"], "cite": f"{act_name} {parsed['orig_sec']}"}
    return {
        "num": parsed["orig_sec"],
        "cite": f"{act_name} § {parsed['orig_sec']}",
    }
