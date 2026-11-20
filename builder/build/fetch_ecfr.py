"""Fetch CFR parts from the eCFR Versioner API and parse into corpus blocks.

Domain specifics (CFR title, chapter, parts, citation prefix, common
names, authority map, naming style) come from a corpus config
(builder/build/corpora/*.json); the securities config is the default.
See docs/corpus-adapter.md.

What a rule keeps (everything that is official regulation text):

* P / FP* paragraphs, nested by their "(a)(1)(i)" markers, with an italic
  run-in heading ("(a) *Definitions.*") moved into the node's `heading`;
* NOTE / CROSSREF / EXAMPLE blocks, in place, as `p` nodes with
  role "note-heading" / "note" (see `_NOTE_TARGET_RE`: a "Note to paragraph
  (a)(5)" attaches to paragraph (a)(5), never resetting the nesting stack);
* EXTRACT blocks (instructions, appendices), nested the same way;
* HD1-3 subheadings and table captions (role "heading");
* FTNT footnotes (role "footnote", superscript-digit marker like the USC
  side, see textutil.superscript);
* TABLE/GPOTABLE tables as `{"type":"table","html":"<table>…</table>"}`
  (table/thead/tbody/tr/th/td only, colspan/rowspan kept);
* images/equations can't be carried, so they leave a visible
  `{"role":"omitted"}` placeholder rather than vanishing silently.

Deliberately NOT kept (editorial apparatus, not rule text): the section HEAD
(it becomes `heading`), CITA (source citations), SECAUTH, EDNOTE ("Editorial
Note: see the List of CFR Sections Affected") and XREF amendment links.
`builder/build/verify_corpus.py` states the same exclusions independently.

Unknown block tags are never dropped: they come through as plain paragraphs
and are recorded in `UNKNOWN_TAGS` (build_corpus prints them).
"""
from __future__ import annotations
import html as _html
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any
import requests
from lxml import etree

from builder.build.corpus_config import default_config
from builder.build.net import make_session
from builder.build.textutil import smart_title, superscript

ECFR_BASE = "https://www.ecfr.gov/api/versioner/v1/full/{date}/title-{title}.xml"
CACHE_ROOT = Path(__file__).resolve().parent / ".cache" / "ecfr"

# tags the collector has met but doesn't know (never dropped: kept as paragraphs)
UNKNOWN_TAGS: set[str] = set()


def _ecfr_cfg(config: dict[str, Any] | None) -> dict[str, Any]:
    """Extract the `ecfr` section of a full corpus config (None = securities)."""
    return (config or default_config())["ecfr"]


@dataclass
class FetchResult:
    part_number: int
    xml: bytes
    from_cache: bool = False


def cache_path(cache_dir: Path, title: int, chapter: str, date: str, part: int) -> Path:
    return Path(cache_dir) / f"title-{title}" / date / f"ch{chapter}-part{part}.xml"


def _ensure_self_ignoring(cache_dir: Path) -> None:
    """The cache lives inside the repo but must never be committed: drop a
    .gitignore ('*', which also ignores itself) at its root."""
    cache_dir.mkdir(parents=True, exist_ok=True)
    gi = cache_dir / ".gitignore"
    if not gi.exists():
        gi.write_text("*\n")


def fetch_part(part: int, date: str, *, session: requests.Session | None = None,
               config: dict[str, Any] | None = None,
               cache_dir: Path | None = None) -> FetchResult:
    """One part's XML as of `date`. With `cache_dir`, the raw XML is read from /
    written to the cache (a date-pinned eCFR snapshot never changes), so
    verify_corpus can re-read exactly what the build parsed without refetching.
    The API requires Accept-Encoding: gzip; net.make_session sends it."""
    cfg = _ecfr_cfg(config)
    cpath = (cache_path(cache_dir, cfg["title"], cfg["chapter"], date, part)
             if cache_dir else None)
    if cpath is not None and cpath.exists() and cpath.stat().st_size > 0:
        return FetchResult(part_number=part, xml=cpath.read_bytes(), from_cache=True)
    url = ECFR_BASE.format(date=date, title=cfg["title"])
    params = {"chapter": cfg["chapter"], "part": str(part)}
    s = session or make_session()
    resp = s.get(url, params=params, timeout=120)
    resp.raise_for_status()
    xml = resp.content
    if cpath is not None:
        _ensure_self_ignoring(Path(cache_dir))
        cpath.parent.mkdir(parents=True, exist_ok=True)
        tmp = cpath.with_suffix(".xml.tmp")
        tmp.write_bytes(xml)
        tmp.replace(cpath)
    return FetchResult(part_number=part, xml=xml)


# --------------------------------------------------------------------------
# text helpers
# --------------------------------------------------------------------------
_MARK_GLUE_RE = re.compile("\\s+(?=[\u2070\u00b9\u00b2\u00b3\u2074-\u2079])")
_DIGITS_RE = re.compile(r"^\s*\d+\s*$")


def _norm(s: str) -> str:
    return _MARK_GLUE_RE.sub("", " ".join(s.split()))


def _is_digit_marker(el) -> bool:
    """<SU>1</SU> / <sup>1</sup>: a footnote (or exponent) digit run."""
    return el.tag in ("SU", "sup") and not len(el) and bool(_DIGITS_RE.match(el.text or ""))


def _inline_text(el, markers: bool = True) -> str:
    """Plain text of an element's content (not its tail). Digit-only SU/sup
    become superscript-digit markers (or vanish when `markers` is false),
    FTREF is empty, <br/> is a space, images contribute nothing."""
    parts: list[str] = []
    if el.text:
        parts.append(el.text)
    for ch in el:
        if not isinstance(ch.tag, str):
            pass  # comment / PI
        elif _is_digit_marker(ch):
            if markers:
                parts.append(superscript(ch.text))
        elif ch.tag == "FTREF":
            pass
        elif ch.tag == "br":
            parts.append(" ")
        else:
            parts.append(_inline_text(ch, markers))
        if ch.tail:
            parts.append(ch.tail)
    return "".join(parts)


def _text_plain(el) -> str:
    """Whitespace-normalized text, markers dropped (headings, captions)."""
    if el is None:
        return ""
    return _norm(_inline_text(el, markers=False))


_CITE_RE = re.compile(r"§\s*(\d+\.\d+[\-a-z0-9]*)")
# A paragraph marker is an enumerator: 1, 12, 2a, a, aa, ii, xxxviii, A, AA, IV.
# Anything else in parentheses at the start of a paragraph is text, not a marker
# ("(Name of Issuer)", "(Signature)", "(Amendment No. __)*" on the schedules).
_MARKER_BODY = (r"\d{1,3}[A-Za-z]{0,2}|[a-z]{1,2}|[ivxlcdm]{1,7}|[A-Z]{1,2}|[IVXLCDM]{1,6}")
_LEADING_MARKER_RE = re.compile(rf"^\(({_MARKER_BODY})\)\s*")
# lowercase roman numerals 1-49 (lists run past xx: § 232.101 goes to xxxviii);
# c/d/l/m are letters here, never numerals
_ROMAN_RE = re.compile(r"^(?=[ivxl]+$)(?:xl|x{0,3})(?:ix|iv|v?i{0,3})$")
_ROMAN_VALUE = {"i": 1, "v": 5, "x": 10, "l": 50}


def _mint_rule_id(cite_num: str, part_number: int) -> str:
    """'230.144' + 230 -> 'r-230-144'; '240.10b-5' + 240 -> 'r-240-10b-5'.
    The one rule-id minting path — reused for both a rule's own id and for
    minting xref targets when linkifying CFR refs in other rules' text."""
    return (f"r-{part_number}-{cite_num.split('.', 1)[1]}"
            if "." in cite_num else f"r-{part_number}-{cite_num}")


# --- xref linkification --------------------------------------------------
# Adds <a class="xref" data-to="<id>">...</a> around resolvable CFR- and
# Act-section references in rule body text. Matches the corpus xref
# convention parse_uslm.py already emits: class + data-to only, no href
# (renderers synthesize href from data-to at render time — see
# render-section.js / build_reader.py's XREF_RE, which requires data-to to
# follow class="xref" immediately). Conservative by design: an unresolved
# reference is left as plain text, never guessed. build_corpus.py's final
# resolvability pass is a second net, not relied on here as the primary
# mechanism (each check below is a real "does this exist" check).

_RULE_TOKEN = r"\d+\.[0-9][\-A-Za-z0-9]*"          # e.g. 230.144, 240.10b-5, 230.144A
_RULE_TOKEN_RE = re.compile(_RULE_TOKEN)
_CFR_CONNECTOR = r"(?:,|and|or|through)"
# A §/§§-introduced ref, optionally followed by more comma/and/or/through
# -joined refs that may or may not repeat their own §/§§.
_CFR_LIST_RE = re.compile(
    rf"§§?\s*{_RULE_TOKEN}(?:\s*{_CFR_CONNECTOR}\s*(?:§§?\s*)?{_RULE_TOKEN})*"
)
_CFR_OCCURRENCE_RE = re.compile(rf"(?:§§?\s*)?{_RULE_TOKEN}")
# "17 CFR 240.10b-5" form — title number checked against this corpus's own
# eCFR title so a citation into a different CFR title never mints an id.
_CFR_TITLE_FORM_RE = re.compile(rf"\b(?P<title>\d+)\s+CFR\s+(?P<token>{_RULE_TOKEN})\b")

# "section 5", "section 4(a)(2)", "sections 13 or 15(d)" — one or more
# section-number tokens (each may carry chained subsection parens) joined
# by comma/and/or, immediately followed by "of the Act", "of the <Act
# short_title>", or "of the <shorthand>" (e.g. "of the Exchange Act" —
# see _act_shorthands). "section" is matched case-insensitively
# (heading-position "Section 4(1)..." is common); "Act"/the act name/the
# shorthand is not, since a bare lowercase "act" is common English ("act
# as agent") and must not match.
_SECTION_TOKEN = r"\d+[A-Za-z]?(?:\([0-9A-Za-z]+\))*"
_SECTION_LIST = rf"{_SECTION_TOKEN}(?:\s*(?:,|and|or)\s*{_SECTION_TOKEN})*"


def _act_ref_re(act_names: list[str]) -> re.Pattern:
    alts = "|".join(re.escape(n) for n in sorted(set(act_names), key=len, reverse=True))
    act_alt = f"Act|{alts}" if alts else "Act"
    return re.compile(
        rf"\b[Ss]ections?\s+(?P<secs>{_SECTION_LIST})\s+of\s+the\s+(?P<act>{act_alt})\b"
    )


_TRAILING_YEAR_RE = re.compile(r"\s+of\s+\d{4}$")


def _act_shorthands(name: str) -> set[str]:
    """Derive candidate shorthand forms of a full act name: the name with
    a trailing ' of <year>' dropped (e.g. 'Securities Exchange Act of
    1934' -> 'Securities Exchange Act'), plus — when that leaves more than
    two words — its own last two words (-> 'Exchange Act'), matching how
    these acts actually get abbreviated in running regulatory text."""
    stripped = _TRAILING_YEAR_RE.sub("", name).strip()
    candidates = {stripped}
    words = stripped.split()
    if len(words) >= 2:
        candidates.add(" ".join(words[-2:]))
    return candidates


def _act_name_lookup(act_translation: dict[str, dict[str, Any]]) -> dict[str, str]:
    """Map every full act name, plus any shorthand derived from exactly one
    act's name, to that act's id. A shorthand another act's full name
    already owns, or that more than one act's name derives, is ambiguous
    and left out entirely — a missed link is fine, a wrong one is not."""
    lookup: dict[str, str] = {}
    for act_id, info in act_translation.items():
        name = info.get("name")
        if name:
            lookup[name] = act_id

    shorthand_owners: dict[str, set[str]] = {}
    for act_id, info in act_translation.items():
        name = info.get("name")
        if not name:
            continue
        for shorthand in _act_shorthands(name):
            if shorthand == name:
                continue
            shorthand_owners.setdefault(shorthand, set()).add(act_id)

    for shorthand, owners in shorthand_owners.items():
        if shorthand in lookup:
            continue  # a real full act name already owns this string
        if len(owners) == 1:
            lookup[shorthand] = next(iter(owners))
    return lookup


def _linkify_cfr_refs(text: str, fetched_parts: set[int], cfr_title: int) -> str:
    def wrap_occurrence(m: re.Match) -> str:
        occ = m.group(0)
        token = _RULE_TOKEN_RE.search(occ).group(0)
        part_num = int(token.split(".", 1)[0])
        if part_num not in fetched_parts:
            return occ
        rule_id = _mint_rule_id(token, part_num)
        return f'<a class="xref" data-to="{rule_id}">{occ}</a>'

    def repl_list(m: re.Match) -> str:
        return _CFR_OCCURRENCE_RE.sub(wrap_occurrence, m.group(0))

    text = _CFR_LIST_RE.sub(repl_list, text)

    def repl_title_form(m: re.Match) -> str:
        if m.group("title") != str(cfr_title):
            return m.group(0)
        token = m.group("token")
        part_num = int(token.split(".", 1)[0])
        if part_num not in fetched_parts:
            return m.group(0)
        rule_id = _mint_rule_id(token, part_num)
        return f'<a class="xref" data-to="{rule_id}">{m.group(0)}</a>'

    return _CFR_TITLE_FORM_RE.sub(repl_title_form, text)


def _linkify_act_refs(
    text: str, act_translation: dict[str, dict[str, Any]] | None, current_act_id: str,
) -> str:
    if not act_translation:
        return text
    name_to_id = _act_name_lookup(act_translation)
    pattern = _act_ref_re(list(name_to_id))

    def wrap_token(m: re.Match, sections: dict[str, str]) -> str:
        token = m.group(0)
        base_num = token.split("(", 1)[0]
        sec_id = sections.get(base_num)
        if not sec_id:
            return token
        path = re.findall(r"\(([0-9A-Za-z]+)\)", token)
        target = "/".join([sec_id, *path])
        return f'<a class="xref" data-to="{target}">{token}</a>'

    def repl(m: re.Match) -> str:
        act_name = m.group("act")
        target_act_id = current_act_id if act_name == "Act" else name_to_id.get(act_name, "")
        sections = act_translation.get(target_act_id, {}).get("sections", {})
        if not sections:
            return m.group(0)
        whole, secs_span = m.group(0), m.group("secs")
        start, end = m.start("secs") - m.start(0), m.end("secs") - m.start(0)
        new_secs = re.sub(_SECTION_TOKEN, lambda tm: wrap_token(tm, sections), secs_span)
        return whole[:start] + new_secs + whole[end:]

    return pattern.sub(repl, text)


def _linkify_rule_content(
    content: list[dict[str, Any]],
    *,
    fetched_parts: set[int],
    cfr_title: int,
    act_translation: dict[str, dict[str, Any]] | None,
    current_act_id: str,
) -> None:
    """Walk a rule's content tree in place, linkifying CFR- and Act-section
    refs found in leaf/container text. Table html is left untouched."""
    def walk(node: dict[str, Any]) -> None:
        if node.get("type") == "table":
            return
        if isinstance(node.get("text"), str):
            text = _linkify_cfr_refs(node["text"], fetched_parts, cfr_title)
            text = _linkify_act_refs(text, act_translation, current_act_id)
            node["text"] = text
        for child in node.get("children") or []:
            walk(child)

    for node in content:
        walk(node)


# --------------------------------------------------------------------------
# block collection: eCFR children -> flat "items" in document order
# --------------------------------------------------------------------------
_SKIP_TAGS = {"HEAD", "CITA", "SECAUTH", "EDNOTE", "XREF", "AUTH", "SOURCE"}
_NOTE_TAGS = {"NOTE", "CROSSREF", "EXAMPLE"}
_NOTELIKE_RE = re.compile(
    r"^(?:Preliminary\s+)?(?:Notes?|Instructions?|Examples?|Cross\s+References?)\b", re.I)
_OMITTED_TEXT = "[Image omitted. See the official text at ecfr.gov.]"


def _is_para_tag(tag: str) -> bool:
    return tag in ("P", "FP", "FRP") or tag.startswith("FP-")


def _is_hd_tag(tag: str) -> bool:
    return tag in ("HD1", "HD2", "HD3", "HED1", "HED2", "HED3")


def _tokens(el) -> list[list]:
    """A paragraph as [("t"|"i", text), …]: top-level <I> children are "i"
    (candidate run-in headings), everything else flattens into "t"."""
    toks: list[list] = []

    def add(kind: str, s: str) -> None:
        if not s:
            return
        if toks and toks[-1][0] == kind == "t":
            toks[-1][1] += s
        else:
            toks.append([kind, s])

    add("t", el.text or "")
    for ch in el:
        if ch.tag == "I":
            add("i", _inline_text(ch))
        elif _is_digit_marker(ch):
            add("t", superscript(ch.text))
        elif ch.tag == "FTREF":
            pass
        elif ch.tag == "br":
            add("t", " ")
        elif isinstance(ch.tag, str):
            add("t", _inline_text(ch))
        add("t", ch.tail or "")
    return toks


def _lead_markers(text: str) -> tuple[list[str], str]:
    """Leading '(a)(1)' markers of `text` and the rest. Only the left edge is
    trimmed: a trailing space may be what separates this text from the next
    inline element, and joining across it must not merge two words."""
    markers: list[str] = []
    rest = text.lstrip()
    while rest.startswith("("):
        match = _LEADING_MARKER_RE.match(rest)
        if not match:
            break
        markers.append(match.group(1).strip())
        rest = rest[match.end():].lstrip()
    return markers, rest


def _extract_markers(text: str) -> tuple[list[str], str]:
    markers, rest = _lead_markers(text)
    return markers, rest.strip()


def _split_heading(h: str) -> tuple[str | None, str]:
    """An italic run after a paragraph marker -> (heading, leftover text).
    A run-in heading ends with a period ("Accredited investor."); the heading
    drops that period, like USC headings. eCFR sometimes italicizes heading and
    defined term in one run ("Accredited investor. Accredited investor");
    that splits when the second half repeats the first. Anything else
    ("Accountant," — a defined term, "Majority ownership:") is not a heading."""
    h = " ".join(h.split())
    if not h:
        return None, ""
    left, sep, right = h.partition(". ")
    if sep and right.lower().startswith(left.lower()):
        return left, right
    if h.endswith(".") and not h.endswith(".."):
        return h[:-1].rstrip(), ""
    return None, ""


def _take_markers(toks: list[list]) -> list[tuple[str, bool]]:
    """Consume the leading '(a)(1)' markers of a paragraph's tokens (in place);
    returns [(marker, italic)]. Italic marks the two deepest C.F.R. levels
    (see _classify_marker), and eCFR writes the italics in three ways: around
    the number only, "(<I>1</I>)"; around the whole marker, "<I>(1)</I>"; or,
    for a marker that is itself followed by its heading in one run,
    "<I>(e) Format.</I>" — there the run is a heading, so the marker is plain."""
    got: list[tuple[str, bool]] = []
    while toks:
        kind, s = toks[0]
        s = s.lstrip()
        if not s:
            toks.pop(0)
            continue
        if kind == "t":
            markers, rest = _lead_markers(s)
            if markers:
                got.extend((m, False) for m in markers)
                if rest.strip():
                    toks[0][1] = rest
                else:
                    toks.pop(0)
                continue
            if s == "(" and len(toks) >= 2 and toks[1][0] == "i":
                body = toks[1][1].strip()
                closed = body.endswith(")")   # "(<I>2)</I>": the source slipped the paren into the italics
                body = body[:-1] if closed else body
                tail = toks[2][1] if len(toks) > 2 and toks[2][0] == "t" else ""
                if re.fullmatch(_MARKER_BODY, body) and (closed or tail.startswith(")")):
                    got.append((body, True))
                    if closed:
                        del toks[:2]
                    else:
                        del toks[:3]
                        if tail[1:].strip():
                            toks.insert(0, ["t", tail[1:].lstrip()])
                    continue
            toks[0][1] = s
            break
        m = _LEADING_MARKER_RE.match(s)
        if not m:
            break
        rest = s[m.end():]
        got.append((m.group(1).strip(), not rest.strip()))
        if rest.strip():
            toks[0] = ["i", rest]
        else:
            toks.pop(0)
    return got


_DASH_RE = re.compile(r"^\s*—\s*")


def _marker_follows(toks: list[list], j: int) -> bool:
    """Is toks[j] an em dash that introduces a paragraph marker
    ("—(1) …", "—(<I>1</I>) …", "—<I>(1)</I> …")?"""
    if j >= len(toks) or toks[j][0] != "t":
        return False
    m = _DASH_RE.match(toks[j][1])
    if not m:
        return False
    probe = [[k, s] for k, s in toks[j:j + 3]]
    probe[0][1] = probe[0][1][m.end():]
    return bool(_take_markers(probe))


def _take_heading(toks: list[list]) -> str | None:
    """Consume the run-in heading that starts at toks[0] (an italic run), or
    return None and leave `toks` alone.

    A heading is the italic run ending in a period (see _split_heading) or an
    italic run ended by an em dash that introduces the next marker:
    "(c) <I>Summary compensation table</I>—(1) <I>General.</I> Provide …".
    The dash is the heading's terminator there (renderers add the period), so
    it is dropped and the (1) nests under (c) with its own heading. Italic runs
    joined by a bare dash are one heading ("Smaller reporting companies—General").
    A *plain-text* lead-in before a dash-introduced marker is not a heading, it
    is the sentence the list continues, and is left alone."""
    heading, leftover = _split_heading(toks[0][1])
    if heading is not None:
        toks.pop(0)
        if leftover:
            toks.insert(0, ["t", leftover])
        elif _marker_follows(toks, 0):
            toks[0][1] = _DASH_RE.sub("", toks[0][1], count=1)
        return heading
    parts = [" ".join(toks[0][1].split())]
    j = 1
    while True:
        if _marker_follows(toks, j):
            del toks[:j]
            toks[0][1] = _DASH_RE.sub("", toks[0][1], count=1)
            return "—".join(parts)
        if (j + 1 < len(toks) and toks[j][0] == "t" and toks[j][1].strip() == "—"
                and toks[j + 1][0] == "i"):
            parts.append(" ".join(toks[j + 1][1].split()))
            j += 2
            continue
        return None


def _para_item(el) -> dict[str, Any] | None:
    toks = _tokens(el)
    specs: list[list] = []   # [marker, heading, italic]
    while toks:
        markers = _take_markers(toks)
        if not markers:
            break
        specs.extend([m, "", italic] for m, italic in markers)
        if toks and toks[0][0] == "i":
            heading = _take_heading(toks)
            if heading is not None:
                specs[-1][1] = heading
    lead_italic = ""
    if not specs and toks and toks[0][0] == "i":
        lead_italic = _norm(toks[0][1])
    text = _norm("".join(t[1] for t in toks))
    if not specs and not text:
        return None
    return {"k": "para", "specs": specs, "text": text, "lead": lead_italic}


def _note_target(hed: str) -> tuple[list[str] | None, bool]:
    """(paragraph chain, root?) a note's heading points at.

    "Note 1 to paragraph (a)(5):"    -> (["a","5"], False)
    "Note to § 230.144(d)(3)(ii):"   -> (["d","3","ii"], False)
    "Instructions to Item 402(t)(2)" -> (["t","2"], False)
    "Note to § 240.13d-2:" / "Notes to § 230.425:" / "Preliminary Note:"
                                      -> (None, True)   (the whole rule)
    "Note:" / "Note 1:" / "Example A:"-> (None, False)  (in place)
    """
    m = re.search(
        r"\bto\s+(?:paragraphs?\b|§§?|Items?\b|items?\b|Rules?\b|rules?\b|section\b|the\s+definition\b)",
        hed)
    if m:
        cm = re.search(r"((?:\([A-Za-z0-9]+\))+)", hed[m.start():])
        if cm:
            return re.findall(r"\(([A-Za-z0-9]+)\)", cm.group(1)), False
        return None, True
    if re.match(r"^\s*Preliminary\b", hed):
        return None, True
    return None, False


def _note_item(el) -> dict[str, Any]:
    hed_el = el.find("HED")
    hed = _text_plain(hed_el) if hed_el is not None else ""
    paras: list[str] = []
    for ch in el:
        if ch is hed_el or not isinstance(ch.tag, str):
            continue
        if ch.tag in ("P", "PSPACE", "FP") or _is_para_tag(ch.tag):
            t = _norm(_inline_text(ch))
            if t:
                paras.append(t)
        else:
            UNKNOWN_TAGS.add(f"{el.tag}/{ch.tag}")
            t = _norm(_inline_text(ch))
            if t:
                paras.append(t)
    chain, root = _note_target(hed)
    return {"k": "note", "hed": hed, "paras": paras, "chain": chain, "root": root}


def _span_attrs(cell) -> str:
    attrs = ""
    for name in ("colspan", "rowspan"):
        v = (cell.get(name) or "").strip()
        if v.isdigit() and int(v) > 1:
            attrs += f' {name}="{int(v)}"'
    return attrs


def _table_html(table) -> str:
    """eCFR HTML table -> sanitized table/thead/tbody/tr/th/td (colspan and
    rowspan kept, classes/styles dropped, cell text escaped). TFOOT rows are
    appended to the body."""
    def row(tr) -> str:
        cells = []
        for c in tr:
            if c.tag not in ("TH", "TD"):
                continue
            tag = c.tag.lower()
            text = _html.escape(_norm(_inline_text(c)), quote=False)
            cells.append(f"<{tag}{_span_attrs(c)}>{text}</{tag}>")
        return "<tr>" + "".join(cells) + "</tr>"

    head_rows, body_rows = [], []
    for sec in table:
        if sec.tag == "THEAD":
            head_rows += [row(tr) for tr in sec if tr.tag == "TR"]
        elif sec.tag in ("TBODY", "TFOOT"):
            body_rows += [row(tr) for tr in sec if tr.tag == "TR"]
        elif sec.tag == "TR":
            body_rows.append(row(sec))
    out = ""
    if head_rows:
        out += "<thead>" + "".join(head_rows) + "</thead>"
    if body_rows:
        out += "<tbody>" + "".join(body_rows) + "</tbody>"
    return f"<table>{out}</table>" if out else ""


def _table_items(el) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    tables = [el] if el.tag == "TABLE" else list(el.iter("TABLE"))
    for tb in tables:
        cap = tb.find("CAPTION")
        if cap is not None:
            ctext = _norm(_inline_text(cap))
            if ctext:
                items.append({"k": "caption", "text": ctext})
        html = _table_html(tb)
        if html:
            items.append({"k": "table", "html": html})
    return items


def _items(parent) -> list[dict[str, Any]]:
    """Children of a section / EXTRACT as an ordered list of items."""
    items: list[dict[str, Any]] = []
    for ch in parent:
        t = ch.tag
        if not isinstance(t, str) or t in _SKIP_TAGS:
            continue
        if _is_para_tag(t):
            it = _para_item(ch)
            if it:
                items.append(it)
        elif _is_hd_tag(t):
            text = _text_plain(ch)
            if text:
                items.append({"k": "heading", "text": text})
        elif t in _NOTE_TAGS:
            items.append(_note_item(ch))
        elif t == "EXTRACT":
            items.append({"k": "extract", "items": _items(ch)})
        elif t in ("DIV", "TABLE"):
            items.extend(_table_items(ch))
        elif t == "FTNT":
            for p in ch:
                if isinstance(p.tag, str) and _is_para_tag(p.tag):
                    text = _norm(_inline_text(p))
                    if text:
                        items.append({"k": "footnote", "text": text})
        elif t in ("MATH", "img"):
            items.append({"k": "omitted"})
        else:
            UNKNOWN_TAGS.add(t)
            text = _norm(_inline_text(ch))
            if text:
                items.append({"k": "para", "specs": [], "text": text, "lead": ""})
    return items


# --------------------------------------------------------------------------
# nesting: items -> content tree
# --------------------------------------------------------------------------
# C.F.R. paragraph hierarchy (Federal Register Document Drafting Handbook), by
# rank: (a) (1) (i) (A), then the same enumerators in italics — (<I>1</I>)
# (<I>i</I>) (<I>A</I>). eCFR keeps those italics, and they are the only thing
# that tells a fifth-level "(1)" from the second-level one. Type names are
# cosmetic (renderers nest by depth); the three italic levels share "item".
_RANK_TYPE = {1: "subsection", 2: "paragraph", 3: "clause", 4: "subparagraph",
              5: "item", 6: "item", 7: "item"}


def _classify_marker(marker: str, stack: list[dict[str, Any]],
                     italic: bool = False, nested: bool = False,
                     upcoming: tuple[str, bool] = ("", False)) -> tuple[str, int]:
    """(type, rank) of a marker given the open `stack`. `nested`: it follows
    another marker on the same line ("(h)(i)"), so it is that marker's child.
    `upcoming`: the next marker in reading order, (marker, italic)."""
    token = marker.strip()

    if italic:
        if token[0].isdigit():
            return _RANK_TYPE[5], 5
        rank = 7 if token.isupper() else 6
        return _RANK_TYPE[rank], rank

    if token.isdigit():
        rank = _digit_rank(int(token), stack)
        return _RANK_TYPE[rank], rank

    if token.isupper():
        return "subparagraph", 4

    if token.islower():
        rank = _lower_rank(token, stack, nested, upcoming)
        return _RANK_TYPE[rank], rank

    return "item", (stack[-1]["rank"] + 1 if stack else 5)


def _roman_value(s: str) -> int:
    total = 0
    for a, b in zip(s, s[1:] + " "):
        v = _ROMAN_VALUE[a]
        total += -v if b in _ROMAN_VALUE and _ROMAN_VALUE[b] > v else v
    return total


def _alpha_next(s: str) -> str:
    """The letter marker after `s`: h -> i, z -> aa, aa -> bb, zz -> aaa ('' if
    `s` is not a letter marker)."""
    c = s[:1]
    if not c.islower() or s != c * len(s):
        return ""
    return "a" * (len(s) + 1) if c == "z" else chr(ord(c) + 1) * len(s)


def _lower_rank(token: str, stack: list[dict[str, Any]], nested: bool,
                upcoming: tuple[str, bool]) -> int:
    """Rank of a plain lowercase marker. A letter (a)…(z), (aa)… is rank 1, a roman
    numeral (i)…(xxxviii) rank 3, and i, v, x, ii, xx are both: (i) after (h) is
    the next letter, (i) after (1) is the first numeral. What decides it: an
    open paragraph this marker is the next number/letter of (a sibling, at any
    depth), then — for "(i)", the one that can start a roman list — what follows
    it ("(ii)" says numeral, "(j)" or a first "(1)" says letter), then the deepest
    open paragraph: a numeral list opens under a (1) whose text can lead into a
    list (not one that ends with a period), never directly under (h) and never as
    a restart beside an open (v)."""
    if not _ROMAN_RE.match(token):
        return 1
    value = _roman_value(token)

    def roman(f):
        n = f["node"].get("num", "")
        return not f["italic"] and bool(_ROMAN_RE.match(n)) and _roman_value(n) + 1 == value

    def letter(f):
        return not f["italic"] and _alpha_next(f["node"].get("num", "")) == token

    roman_at = next((i for i in range(len(stack) - 1, -1, -1) if roman(stack[i])), None)
    letter_at = None if nested else next(
        (i for i in range(len(stack) - 1, -1, -1) if letter(stack[i])), None)
    if roman_at is not None and (letter_at is None or roman_at > letter_at):
        return stack[roman_at]["rank"]
    if letter_at is not None:
        if token == "i":
            nxt, nxt_italic = upcoming
            if not nxt_italic and nxt == "ii":
                return 3                          # the numeral list goes on
            if not nxt_italic and nxt in ("j", "1"):
                return stack[letter_at]["rank"]   # the next letter, or its first (1)
            top = stack[-1]
            if top["rank"] == 2 and not top["node"].get("text", "").rstrip().endswith("."):
                return 3                          # a lead-in that can introduce numerals
        return stack[letter_at]["rank"]
    return 3 if stack else 1


def _digit_rank(n: int, stack: list[dict[str, Any]]) -> int:
    """Rank of a plain "(n)". Normally the second level (2). A digit that is the
    next number after an open plain-digit paragraph continues that list, however
    deep the stack has grown since ("(2)" after (a)(1)(i)(A)(<I>1</I>) is the
    second paragraph, not an item of (A)). Otherwise, inside an (A) or deeper, it
    opens a list of its own at rank 5: the fifth level written without italics,
    unless it is a later number of the open second-level list (a skipped paragraph)."""
    def num(f):
        v = f["node"].get("num", "")
        return int(v) if v.isdigit() and not f["italic"] else None

    for f in reversed(stack):
        if num(f) is not None and num(f) + 1 == n:
            return f["rank"]
    if stack and stack[-1]["rank"] >= 4:
        l2 = next((f for f in stack if f["rank"] == 2), None)
        if l2 is not None and num(l2) is not None and n > num(l2):
            return 2
        return 5
    return 2


def _upcoming_marker(items: list[dict[str, Any]], pos: int, si: int) -> tuple[str, bool]:
    """The marker right after spec `si` of items[pos], as (marker, italic): the
    next one on the same line, else the first of the next marked paragraph (notes
    and tables are looked through). ("", False) when an unmarked paragraph or a
    subheading — a new region — or the end comes first."""
    specs = items[pos]["specs"]
    if si + 1 < len(specs):
        return specs[si + 1][0], specs[si + 1][2]
    for nxt in items[pos + 1:]:
        if nxt["k"] == "heading":
            break
        if nxt["k"] == "para":
            return (nxt["specs"][0][0], nxt["specs"][0][2]) if nxt["specs"] else ("", False)
    return "", False


def _p(role: str | None, text: str) -> dict[str, Any]:
    node: dict[str, Any] = {"type": "p", "text": text}
    if role:
        node["role"] = role
    return node


def _item_nodes(it: dict[str, Any]) -> list[dict[str, Any]]:
    """Nodes for a non-paragraph item (note/heading/table/…)."""
    k = it["k"]
    if k == "note":
        nodes = [_p("note-heading", it["hed"])] if it["hed"] else []
        nodes += [_p("note", t) for t in it["paras"]]
        return nodes
    if k in ("heading", "caption"):
        return [_p("heading", it["text"])]
    if k == "table":
        return [{"type": "table", "html": it["html"]}]
    if k == "footnote":
        return [_p("footnote", it["text"])]
    if k == "omitted":
        return [_p("omitted", _OMITTED_TEXT)]
    raise ValueError(f"unexpected item kind {k!r}")


def _nest(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Build the content tree from ordered items.

    Marked paragraphs ("(a)", "(1)", "(i)", "(A)", italic "(1)", italic "(i)" …)
    nest by rank on `stack`; a marker never resets it. Notes, captions, tables, footnotes and EXTRACT blocks attach *in place*
    (to the paragraph they follow, or the one a note's heading names) and never
    touch `stack`, so a note in the middle of (a)(5)(i)…(ii) doesn't reset the
    nesting of what follows. A section-level HD subheading and a plain
    unmarked paragraph start a new region, as before: root level, stack cleared.
    """
    root: list[dict[str, Any]] = []
    stack: list[dict[str, Any]] = []   # frames: rank, type, node, chain

    def attach(nodes: list[dict[str, Any]], chain, to_root: bool) -> None:
        """Place `nodes` in reading order: under the paragraph `chain` names
        (else the one just read; whole-rule notes go to root level). Frames
        deeper than the target are dropped so anything that follows continues
        after the note instead of scrambling back into an earlier subtree."""
        if to_root:
            root.extend(nodes)
            stack.clear()
            return
        frame = None
        if stack:
            frame = stack[-1]
            if chain:
                exact = next((f for f in reversed(stack) if f["chain"] == chain), None)
                if exact is not None:
                    frame = exact
                else:  # deepest ancestor whose path is a prefix of the target
                    for f in reversed(stack):
                        if f["chain"] == chain[: len(f["chain"])]:
                            frame = f
                            break
            idx = next(i for i, f in enumerate(stack) if f is frame)
            del stack[idx + 1:]
        parent = root if frame is None else frame["node"].setdefault("children", [])
        parent.extend(nodes)

    for pos, it in enumerate(items):
        k = it["k"]
        if k == "para":
            specs, text = it["specs"], it["text"]
            if not specs:
                lead = it["lead"]
                if lead and _NOTELIKE_RE.match(lead):
                    chain, to_root = _note_target(lead)
                    attach([_p("note", text)], chain, to_root)
                else:
                    root.append({"type": "p", "text": text})
                    stack.clear()
                continue
            for si, (marker, heading, italic) in enumerate(specs):
                block_type, rank = _classify_marker(
                    marker, stack, italic, nested=si > 0,
                    upcoming=_upcoming_marker(items, pos, si))
                while stack and stack[-1]["rank"] >= rank:
                    stack.pop()
                parent = root if not stack else stack[-1]["node"].setdefault("children", [])
                node = {"type": block_type, "num": marker, "heading": heading, "children": []}
                parent.append(node)
                chain = (stack[-1]["chain"] if stack else []) + [marker]
                stack.append({"rank": rank, "type": block_type, "node": node, "chain": chain,
                              "italic": italic})
            if text:
                stack[-1]["node"]["text"] = text
            elif not stack[-1]["node"]["children"]:
                stack[-1]["node"]["text"] = ""
        elif k == "heading":
            root.append(_p("heading", it["text"]))
            stack.clear()
        elif k == "extract":
            nodes = _nest(it["items"])
            first = next((i for i in it["items"] if i["k"] in ("para", "note")), None)
            chain, to_root = (None, False)
            if first is not None:
                lead = first.get("lead") or first.get("hed") or ""
                if lead and (first["k"] == "note" or _NOTELIKE_RE.match(lead)):
                    chain, to_root = _note_target(lead)
            attach(nodes, chain, to_root)
        elif k == "note":
            attach(_item_nodes(it), it["chain"], it["root"])
        else:
            attach(_item_nodes(it), None, False)
    return _prune_empty_children(root)


def _prune_empty_children(blocks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for block in blocks:
        children = _prune_empty_children(block.get("children", [])) if block.get("children") else []
        if children:
            block["children"] = children
        else:
            block.pop("children", None)
        out.append(block)
    return out


def _parse_ecfr_blocks(sec_el) -> list[dict[str, Any]]:
    return _nest(_items(sec_el))


# --------------------------------------------------------------------------
# rule headings, groups, names
# --------------------------------------------------------------------------
def _rule_heading(head_text: str, n: str) -> str:
    """The section's subject: its HEAD without the leading '§ N'. Using the N
    attribute (not a regex over the text) is what keeps '§ 230.144A Private
    resales…' from losing its suffix letter into the heading."""
    prefix = f"§ {n}"
    if head_text.startswith(prefix):
        rest = head_text[len(prefix):]
    else:  # "§§ 230.445-230.447 [Reserved]", "§ 249.1900. Form SCI…"
        rest = re.sub(r"^§§?\s*\S+(?:\s+-\s+\S+)?", "", head_text)
    return rest.lstrip(" .").strip()


def _family(num: str) -> str:
    """Rule-number family used to decide which subject groups belong to a
    flattened 'Regulation' marker: 12b-1 -> 12b, 12d1-1 -> 12d1, 12-01 -> 12,
    401 -> 4 (pure numbers group by hundreds)."""
    m = re.match(r"[0-9]+[A-Za-z]*[0-9]*", num)
    fam = m.group(0) if m else num
    if fam.isdigit() and len(fam) >= 3:
        return fam[:-2]
    return fam


def _rule_num(n: str) -> str:
    return n.split(".", 1)[1] if "." in n else n


def _group_short(label: str) -> str:
    m = re.match(r"^(Regulation\s+[A-Za-z0-9][A-Za-z0-9\-\u2013]*)(?:\s*[\u2014:]|\s*$)", label)
    if m:
        return m.group(1)
    m = re.search(r"\((Regulation\s+[^)]+)\)", label)
    if m:
        return m.group(1)
    return label


def _slug(s: str, limit: int = 40) -> str:
    """lowercase-hyphen slug, cut at a word boundary (never mid-word)."""
    s = re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")
    if len(s) <= limit:
        return s
    cut = s[:limit]
    if s[limit] != "-" and "-" in cut:
        cut = cut.rsplit("-", 1)[0]
    return cut.strip("-")


class _Group:
    def __init__(self, label: str, kind: str, parent: "_Group | None" = None,
                 key: str = "") -> None:
        self.label = label
        self.kind = kind          # "subpart" | "hed" | "subj"
        self.parent = parent
        self.key = key            # subpart N
        self.rules: list[str] = []
        self.family: set[str] = set()
        self.absorbs = False
        self.id = ""

    def add(self, rule_id: str, fam: str) -> None:
        g: _Group | None = self
        while g is not None:
            g.rules.append(rule_id)
            g.family.add(fam)
            g = g.parent


def _el_label(el, acronyms) -> str:
    head = el.find("HEAD")
    if head is None:
        head = el.find("HED")
    text = _text_plain(head) if head is not None else _text_plain(el)
    return smart_title(text, acronyms)


def _build_groups(part_el, part_number: int, title: int, acronyms) -> tuple[list[dict[str, Any]], dict[str, str]]:
    """Subject groups / subparts of a part -> (groups, {section N: leaf group id}).

    eCFR's hierarchy is only partly nested: a "Regulation" heading may be an
    empty DIV7 (or a bare HED1 center heading) followed by its sections and
    sub-headings as *siblings* at part level. So groups are derived in document
    order (see module docs of the tests): a nested DIV7 owns its sections; a
    section sitting directly under the part belongs to the last 'flat' marker
    (empty DIV7 / HED1 / subpart); a non-'Regulation' DIV7 following a flat
    top-level marker is folded in as its sub-group while its rules share the
    marker's rule-number family (so Regulation 12B takes 12b-1…12b-37 but not
    12d1-1)."""
    sec_els = [s for s in part_el.iter("DIV8") if s.get("TYPE") == "SECTION"]
    subparts = [d for d in part_el.iter("DIV6")]
    real_subparts = [d for d in subparts if any(s.get("TYPE") == "SECTION" for s in d.iter("DIV8"))]
    multi = len(real_subparts) >= 2

    groups: list[_Group] = []
    group_of_el: dict[Any, _Group] = {}
    leaf_of: dict[str, _Group] = {}
    state = {"top": None, "flat": None}

    def new_top(label, kind, key=""):
        g = _Group(label, kind, None, key)
        groups.append(g)
        state["top"] = g
        return g

    def new_sub(label, parent):
        g = _Group(label, "subj", parent)
        groups.append(g)
        return g

    def fam_of(el):
        return {_family(_rule_num(s.get("N", ""))) for s in el.iter("DIV8")
                if s.get("TYPE") == "SECTION"}

    def visit(el, parent_el):
        for ch in el:
            tag = ch.tag
            if tag == "DIV8" and ch.get("TYPE") == "SECTION":
                n = ch.get("N", "")
                owner = (group_of_el.get(parent_el) if parent_el is not part_el else None)
                if owner is None and parent_el is not part_el and parent_el.tag == "DIV6":
                    owner = state["flat"]  # sections of an ignored subpart
                if owner is None and parent_el is part_el:
                    owner = state["flat"]
                if owner is not None:
                    rid = _mint_rule_id(n, part_number)
                    owner.add(rid, _family(_rule_num(n)))
                    leaf_of[n] = owner
            elif tag == "HED1" and parent_el is part_el:
                g = new_top(smart_title(_text_plain(ch), acronyms), "hed")
                g.absorbs = True
                state["flat"] = g
            elif tag == "DIV6":
                label = _el_label(ch, acronyms)
                if multi or label.startswith("Regulation"):
                    g = new_top(label, "subpart", ch.get("N", ""))
                    g.absorbs = True
                    group_of_el[ch] = g
                    state["flat"] = g
                visit(ch, ch)
            elif tag == "DIV7":
                label = _el_label(ch, acronyms)
                empty = not any(s.get("TYPE") == "SECTION" for s in ch.iter("DIV8"))
                top = state["top"]
                if parent_el.tag == "DIV7":
                    g = new_sub(label, group_of_el[parent_el])
                elif parent_el.tag == "DIV6" and parent_el in group_of_el:
                    g = new_sub(label, group_of_el[parent_el])
                else:
                    fam = fam_of(ch)
                    foldable = (
                        top is not None and top.absorbs and top.kind != "subpart"
                        and not label.startswith("Regulation")
                        and (not fam or not top.family or fam & top.family)
                    )
                    if foldable:
                        g = new_sub(label, top)
                    else:
                        g = new_top(label, "subj")
                        g.absorbs = empty
                group_of_el[ch] = g
                if empty:
                    state["flat"] = g
                elif g.parent is None:
                    state["flat"] = None
                visit(ch, ch)

    visit(part_el, part_el)

    # drop empty groups, assign stable ids
    kept = [g for g in groups if g.rules]
    used: set[str] = set()
    out: list[dict[str, Any]] = []
    for g in kept:
        short = _group_short(g.label)
        if g.kind == "subpart" and short == g.label and g.key:
            slug = f"subpart-{_slug(g.key)}"
        elif short.startswith("Regulation "):
            slug = "reg" + re.sub(r"[^a-z0-9\-]", "", short[len("Regulation "):].lower())
        else:
            slug = _slug(g.label)
        base = f"cfr-{title}-p{part_number}-" if g.parent is None else g.parent.id + "-"
        gid = base + slug
        n = 2
        while gid in used:
            gid = f"{base}{slug}-{n}"
            n += 1
        used.add(gid)
        g.id = gid
        out.append({
            "id": gid,
            "label": g.label,
            "short": short,
            "parent": g.parent.id if g.parent is not None else "",
            "rules": list(g.rules),
        })
    return out, {n: g.id for n, g in leaf_of.items() if g.rules}


def _end_groups(groups: list[dict[str, Any]], group_of: dict[str, str], ends: dict[str, str],
                part_number: int) -> None:
    """Curated ends for flat 'Regulation' headings the eCFR never closes
    (config `ecfr.group_ends[<part>]`: {group short name: last section N}).
    The sections after the end belong to no subject group: Rule 701 is not
    Regulation E, and Rules 13e-1 to 13q-1 are not Regulation 13D-G."""
    for g in groups:
        last = ends.get(g["short"])
        if not last:
            continue
        last_id = _mint_rule_id(last, part_number)
        if last_id not in g["rules"]:
            raise ValueError(f"group_ends: {last} is not in {g['short']} (part {part_number})")
        tail = set(g["rules"][g["rules"].index(last_id) + 1:])
        g["rules"] = [r for r in g["rules"] if r not in tail]
        for n in [n for n, gid in group_of.items() if gid == g["id"] and _mint_rule_id(n, part_number) in tail]:
            del group_of[n]


_FORM_RE = re.compile(r"^((?:Forms?|Schedule)\s+[A-Za-z0-9][\w\-/]*)")
_SCHEDULE_RE = re.compile(r"^(Schedule\s+[A-Za-z0-9][\w\-]*)")


def _rule_names(cite_num: str, heading: str, part: int, group_short: str,
                cfg: dict[str, Any]) -> tuple[str, str]:
    """(common_name, short_name). Config `ecfr.name_style[<part>]`:
    kind  rule (default) -> "Rule 144" / "Rule 4-01 of Regulation S-X";
          item           -> "Item 404 of Regulation S-K";
          form           -> the form name from the heading ("Form S-1");
    of    the regulation the rule belongs to ("Regulation S-X"), optional;
    use_group  take "of Regulation X" from the subject group's short name when
          it is a Regulation (Part 242: Regulation M, SHO, NMS …).
    `ecfr.common_names` overrides everything (curated exceptions)."""
    override = cfg["common_names"].get(cite_num)
    if override:
        return override, override
    if heading.strip().startswith("[Reserved]") or "[Reserved]" in heading:
        return "", ""
    style = cfg.get("name_style", {}).get(str(part), {})
    kind = style.get("kind", "rule")
    num = _rule_num(cite_num)
    of = style.get("of", "")
    if style.get("use_group") and group_short.startswith("Regulation "):
        of = group_short
    if kind == "form":
        m = _FORM_RE.match(heading)
        if not m:
            return "", ""
        name = m.group(1).rstrip(",.:;")
        return name, name
    if kind == "rule" and style.get("schedules"):
        m = _SCHEDULE_RE.match(heading)
        if m:
            name = m.group(1).rstrip(",.:;")
            return name, name
    label = "Item" if kind == "item" else "Rule"
    short = f"{label} {num}"
    return (f"{short} of {of}" if of else short), short


def _display_title(head: str, part_number: int, acronyms) -> str:
    """'PART 230—GENERAL RULES AND REGULATIONS, …' -> 'General Rules and Regulations, …'."""
    t = re.sub(rf"^PART\s+{part_number}\s*[\u2014\u2013-]\s*", "", head.strip(), flags=re.I)
    return smart_title(t, acronyms)


def parse_part_xml(
    xml_bytes: bytes, part_number: int,
    config: dict[str, Any] | None = None,
    fetched_parts: set[int] | None = None,
    act_translation: dict[str, dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Parse eCFR Part XML (DIV5 TYPE=PART root, DIV8 TYPE=SECTION children).

    `fetched_parts` gates CFR-ref linkification (a ref only links if its
    target part is among these; default: every part in the config).
    `act_translation` (see build_corpus._act_translation_table) enables
    Act-ref linkification; omitted, Act refs are left as plain text.
    """
    cfg = _ecfr_cfg(config)
    title = cfg["title"]
    acronyms = cfg.get("acronyms", [])
    root = etree.fromstring(xml_bytes)
    # Current API: DIV5 TYPE="PART" root; legacy: bare PART tag
    if root.tag == "DIV5" and root.get("TYPE") == "PART":
        part_el = root
    elif root.tag == "PART":
        part_el = root
    else:
        part_el = root.find('.//*[@TYPE="PART"]')
        if part_el is None:
            part_el = root.find(".//PART")

    if part_el is None:
        return {"id": f"cfr-{title}-p{part_number}", "title": f"{title} CFR Part {part_number}",
                "heading": "", "part": part_number, "display_title": "",
                "short_title": cfg.get("part_short_titles", {}).get(str(part_number), ""),
                "authority_act": "", "groups": [], "rules": []}

    heading_text = _text_plain(part_el.find("HEAD")).strip()
    # Current API: DIV8 TYPE="SECTION"; legacy: SECTION tag
    section_els = part_el.findall('.//*[@TYPE="SECTION"]') or list(part_el.iter("SECTION"))
    if part_el.tag == "DIV5":
        groups, group_of = _build_groups(part_el, part_number, title, acronyms)
        _end_groups(groups, group_of, cfg.get("group_ends", {}).get(str(part_number), {}), part_number)
    else:
        groups, group_of = [], {}
    short_of = {g["id"]: g["short"] for g in groups}
    rules = [
        _parse_ecfr_section(s, part_number, cfg, fetched_parts, act_translation,
                            group_id=group_of.get(s.get("N", ""), ""),
                            group_short=short_of.get(group_of.get(s.get("N", ""), ""), ""))
        for s in section_els
    ]
    display_title = _display_title(heading_text, part_number, acronyms)
    return {
        "id": f"cfr-{title}-p{part_number}",
        "title": f"{title} CFR Part {part_number}",
        "heading": heading_text,
        "part": part_number,
        "display_title": display_title,
        # curated short name for the default part title ("Regulation S-K");
        # falls back to display_title for a part with no entry in the config
        "short_title": cfg.get("part_short_titles", {}).get(str(part_number), display_title),
        "authority_act": cfg["authority_map"].get(str(part_number), ""),
        "groups": groups,
        "rules": rules,
    }


def _parse_ecfr_section(
    sec_el, part_number: int, cfg: dict[str, Any],
    fetched_parts: set[int] | None = None,
    act_translation: dict[str, dict[str, Any]] | None = None,
    group_id: str = "", group_short: str = "",
) -> dict[str, Any]:
    # Current API: N attr on DIV8 holds cite; legacy API uses SECTNO/SUBJECT tags
    n_attr = sec_el.get("N", "")
    head_text = _text_plain(sec_el.find("HEAD"))
    if n_attr:
        cite_num = n_attr
        subject = _rule_heading(head_text, n_attr)
    else:
        sectno_text = _text_plain(sec_el.find("SECTNO"))
        subject = _text_plain(sec_el.find("SUBJECT"))
        m = _CITE_RE.search(sectno_text) if sectno_text else None
        cite_num = m.group(1) if m else sectno_text.strip().lstrip("§ ").strip()
    rule_id = _mint_rule_id(cite_num, part_number)
    content = _parse_ecfr_blocks(sec_el)
    _linkify_rule_content(
        content,
        fetched_parts=fetched_parts if fetched_parts is not None else set(cfg["parts"]),
        cfr_title=cfg["title"],
        act_translation=act_translation,
        current_act_id=cfg["authority_map"].get(str(part_number), ""),
    )
    common, short = _rule_names(cite_num, subject, part_number, group_short, cfg)
    rule = {
        "id": rule_id,
        "cite": f"{cfg['cite_prefix']} § {cite_num}",
        "common_name": common,
        "short_name": short,
        "heading": subject,
        "group": group_id,
        "content": content,
    }
    aliases = cfg.get("aliases", {}).get(cite_num)
    if aliases:
        rule["aliases"] = list(aliases)
    return rule


def fetch_all(
    date: str, parts: list[int] | None = None,
    config: dict[str, Any] | None = None,
    act_translation: dict[str, dict[str, Any]] | None = None,
    cache_dir: Path | None = None,
) -> list[dict[str, Any]]:
    """Fetch + parse every target part. A part that can't be fetched is FATAL:
    a corpus silently missing a regulation is worse than a failed refresh.

    `act_translation` (build_corpus._act_translation_table) enables Act-ref
    linkification in rule text; omitted (the default), fetch_ecfr stays
    importable/testable standalone and Act refs are left as plain text.
    """
    parts = parts or _ecfr_cfg(config)["parts"]
    fetched_parts = set(parts)
    out: list[dict[str, Any]] = []
    session = make_session()
    for p in parts:
        try:
            extra = {"cache_dir": cache_dir} if cache_dir else {}
            result = fetch_part(p, date, session=session, config=config, **extra)
        except requests.RequestException as e:
            raise RuntimeError(f"eCFR part {p} fetch failed: {e}") from e
        out.append(parse_part_xml(
            result.xml, p, config=config,
            fetched_parts=fetched_parts, act_translation=act_translation,
        ))
    return out
