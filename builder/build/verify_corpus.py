"""Correctness proof for builder/corpus.json.

For EVERY provision this re-derives the word sequence straight from the source
XML with a deliberately simple extractor that shares no code with the parsers
(parse_uslm.py / fetch_ecfr.py), flattens the corpus text the way a reader
would see it, and compares the two.

    python -m builder.build.verify_corpus            # writes builder/verify_report.json
    exit status 1 if any provision has a non-whitespace mismatch

Source-side extraction (the whole definition, so a reviewer can audit it):

* USLM (usc15.xml): every character of the section except the section's own
  <num> and <heading>, <sourceCredit>, <notes> (statutory/editorial notes),
  footnote <note>s and footnote markers (footnoteRef, digit-only <sup>).
  Tables contribute their cell text. Footnote bodies are verified separately:
  the multiset of source footnote bodies must equal the corpus nodes with
  role "footnote".
* eCFR (DIV8 TYPE=SECTION): every character of the section except HEAD,
  CITA (source citation), SECAUTH, EDNOTE (editorial note), XREF (amendment
  link) and digit-only SU/sup footnote markers; NOTE, EXTRACT, CROSSREF,
  EXAMPLE, FTNT, HD*, table captions and table cell text all count. Images
  (img/MATH) have no text. One source character is read differently: an em
  dash that directly follows an italic run and directly precedes a "(" marker
  ends a run-in heading ("(c) <I>Summary compensation table</I>—(1) …"); the
  corpus keeps the heading and nests the (1), and readers print the period, so
  the dash reads as '. ' (see _HEADING_DASH; the report counts these).

Corpus-side flattening: num as "(a)", heading (CFR headings regain the period
the parser moved out), text with xref anchors removed, children in order,
tables as cell text; footnote-marker superscripts removed; nodes with role
"omitted" (image placeholders) skipped; for USC, role "footnote" nodes skipped
(checked separately).

Both sides are compared as whitespace-split words after one shared
canonicalization (")(" -> ") (" so "(a)(1)" and "(a) (1)" agree). A provision is
"exact" when the word lists are equal; "whitespace_only" when they differ only
in where spaces fall (the characters are identical); anything else is a
mismatch with its first diff. Also checked: every source section appears in
the corpus and vice versa, and every heading equals its source heading.
"""
from __future__ import annotations
import argparse
import datetime as dt
import difflib
import html
import json
import re
import sys
from pathlib import Path
from typing import Any

from lxml import etree

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from builder.build.corpus_config import DEFAULT_CONFIG_PATH, load_config

ROOT = Path(__file__).resolve().parents[2]
BUILDER_DIR = ROOT / "builder"
DEFAULT_CACHE = Path(__file__).resolve().parent / ".cache" / "ecfr"

METHOD = (
    "Independent word-sequence comparison per provision. USC: section text minus its own "
    "num/heading, sourceCredit, notes, footnote notes and footnote markers (footnote bodies "
    "and headings compared separately), tables as cell text. eCFR: section text minus HEAD, "
    "CITA, SECAUTH, EDNOTE, XREF and digit-only SU/sup markers; NOTE/EXTRACT/CROSSREF/EXAMPLE/"
    "FTNT/HD*/captions/table cells included; HEAD compared separately; an em dash between an "
    "italic run-in heading and the next '(' marker reads as the heading's period (counted in "
    "heading_dash). Corpus text flattened as "
    "the reader shows it (xref anchors and superscript footnote markers removed, image "
    "placeholders skipped). Words compared in order."
)

USLM = "{http://xml.house.gov/schemas/uslm/1.0}"
_SUPERS = re.compile("[⁰¹²³⁴-⁹]")
_XREF_OPEN = re.compile(r'<a class="xref" data-to="[^"]*">')
_TAG_RE = re.compile(r"<[^>]+>")


# ---------------------------------------------------------------- shared
def _canon(s: str) -> list[str]:
    s = s.replace(")(", ") (").replace(")(", ") (")
    return s.split()


def _is_digits(text: str | None) -> bool:
    return bool(text) and text.strip().isdigit()


def _ln(el) -> str:
    return etree.QName(el).localname


def _walk(nodes):
    for n in nodes:
        yield n
        yield from _walk(n.get("children") or [])


# ------------------------------------------------------- corpus flattening
def _plain(s: str) -> str:
    s = _XREF_OPEN.sub("", s).replace("</a>", "")
    return _SUPERS.sub("", s)


def _table_text(h: str) -> str:
    h = re.sub(r"</t[dh]>|</tr>|<br\s*/?>", " ", h)
    return _SUPERS.sub("", html.unescape(_TAG_RE.sub("", h)))


def flatten(nodes: list[dict[str, Any]], kind: str) -> list[str]:
    """Words of a content tree, in reading order. kind: 'usc' | 'cfr'."""
    out: list[str] = []
    for n in _walk(nodes):
        role = n.get("role")
        if role == "omitted" or (role == "footnote" and kind == "usc"):
            continue
        if n.get("type") == "table":
            out.append(_table_text(n.get("html", "")))
            continue
        if n.get("num"):
            out.append(f"({n['num']})")
        if n.get("heading"):
            out.append(_plain(n["heading"]) + ("." if kind == "cfr" else ""))
        if n.get("text"):
            out.append(_plain(n["text"]))
    return _canon(" ".join(out))


def footnote_bodies(nodes: list[dict[str, Any]]) -> list[tuple[str, ...]]:
    return sorted(tuple(_canon(_plain(n.get("text", "")))) for n in _walk(nodes)
                  if n.get("role") == "footnote")


# ---------------------------------------------------------------- USLM side
_USC_INLINE = {"ref", "date", "i", "b", "sub", "sup", "inline", "span", "a"}


def _usc_walk(el, top: bool, chunks: list[str]) -> None:
    tag = _ln(el)
    if tag in ("notes", "sourceCredit", "note"):
        return
    if tag == "ref" and el.get("class") == "footnoteRef":
        return
    if tag == "sup" and not len(el) and _is_digits(el.text):
        return
    if tag == "sup" and len(el) and all(
            _ln(c) == "ref" and c.get("class") == "footnoteRef" for c in el):
        return
    if top and tag in ("num", "heading"):
        return
    block = tag not in _USC_INLINE
    if block:
        chunks.append(" ")
    chunks.append(el.text or "")
    for ch in el:
        if isinstance(ch.tag, str):
            _usc_walk(ch, False, chunks)
        chunks.append(ch.tail or "")
    if block:
        chunks.append(" ")


def usc_words(sec) -> list[str]:
    chunks = [sec.text or ""]
    for ch in sec:
        if isinstance(ch.tag, str):
            _usc_walk(ch, True, chunks)
        chunks.append(ch.tail or "")
    return _canon("".join(chunks))


def usc_heading_words(sec) -> list[str]:
    h = sec.find(USLM + "heading")
    if h is None:
        return []
    chunks: list[str] = []
    _usc_walk(h, False, chunks)
    return _canon("".join(chunks))


def usc_footnotes(sec) -> list[tuple[str, ...]]:
    found = []
    for note in sec.iter(USLM + "note"):
        if note.get("type") != "footnote":
            continue
        if any(_ln(a) == "notes" for a in note.iterancestors()):
            continue
        parts = [note.text or ""]
        for ch in note:
            if _ln(ch) != "num":
                parts.append("".join(ch.itertext()))
            parts.append(ch.tail or "")
        found.append(tuple(_canon("".join(parts))))
    return sorted(found)


# --------------------------------------------------------------- eCFR side
_CFR_SKIP = {"HEAD", "CITA", "SECAUTH", "EDNOTE", "XREF"}
_CFR_INLINE = {"I", "E", "SU", "sup", "sub", "FR", "strong", "em", "b", "i", "FTREF"}


# "(c) <I>Summary compensation table</I>—(1) <I>General.</I> …": the corpus keeps the
# run-in heading as (c)'s heading and nests (1) under it, so the em dash that ended the
# heading is stored as the heading's terminator (readers print the period). This is the
# ONE place the verifier lets a source character differ: an em dash right after an
# italic run and right before a "(" marker, in a paragraph that itself starts with a
# marker. (An unmarked paragraph such as "<I>Trading facility</I>—(1) <I>In
# general.</I> …" is kept whole as text, so its dash must still match.)
# `stats["heading_dash"]` counts them so the report shows how many rely on it.
_HEADING_DASH = re.compile(r"^\s*—(?=\s*\()")


def _starts_with_marker(p) -> bool:
    first = p[0] if len(p) else None
    return ((p.text or "").lstrip().startswith("(")
            or (not (p.text or "").strip() and first is not None and first.tag == "I"
                and (first.text or "").lstrip().startswith("(")))


def _heading_dash_tail(ch, stats: dict[str, int] | None) -> str:
    """ch.tail, with the heading-terminating em dash (see above) read as '. '."""
    tail = ch.tail or ""
    if ch.tag != "I" or ch.getparent() is None or not _starts_with_marker(ch.getparent()):
        return tail
    nxt = ch.getnext()
    m = _HEADING_DASH.match(tail)
    if not m and tail.strip() == "—" and nxt is not None and nxt.tag == "I" \
            and (nxt.text or "").startswith("("):
        m = re.match(r"^\s*—", tail)        # "—<I>(1)</I>"
    if not m:
        return tail
    if stats is not None:
        stats["heading_dash"] = stats.get("heading_dash", 0) + 1
    return ". " + tail[m.end():]


def _cfr_walk(el, chunks: list[str], stats: dict[str, int] | None = None) -> None:
    tag = el.tag
    if tag in _CFR_SKIP:
        return
    if tag in ("SU", "sup") and not len(el) and _is_digits(el.text):
        return
    if tag == "br":
        chunks.append(" ")
        return
    block = tag not in _CFR_INLINE
    if block:
        chunks.append(" ")
    chunks.append(el.text or "")
    for ch in el:
        if isinstance(ch.tag, str):
            _cfr_walk(ch, chunks, stats)
        chunks.append(_heading_dash_tail(ch, stats))
    if block:
        chunks.append(" ")


def cfr_words(sec, stats: dict[str, int] | None = None) -> list[str]:
    chunks = [sec.text or ""]
    for ch in sec:
        if isinstance(ch.tag, str):
            _cfr_walk(ch, chunks, stats)
        chunks.append(_heading_dash_tail(ch, stats))
    return _canon("".join(chunks))


def cfr_head_words(sec) -> list[str]:
    """Words of the section HEAD, minus digit-only footnote markers."""
    head = sec.find("HEAD")
    if head is None:
        return []
    parts = [head.text or ""]
    for ch in head:
        if not (ch.tag in ("SU", "sup") and not len(ch) and _is_digits(ch.text)):
            parts.append("".join(ch.itertext()))
        parts.append(ch.tail or "")
    return _canon("".join(parts))


def heading_problem(heading: str, head_words: list[str]) -> str:
    """'' when the rule heading is exactly the source HEAD minus its leading
    '§ <number>' (so a stray suffix letter, or a lost word, is caught);
    otherwise a description."""
    got = _canon(heading)
    if not got:
        return ""
    prefix = head_words[: len(head_words) - len(got)]
    ok = (
        len(head_words) > len(got)
        and head_words[len(head_words) - len(got):] == got
        and prefix and prefix[0].startswith("§")
        and len(prefix) <= 5
        and all(t.startswith("§") or re.fullmatch(r"[\dA-Za-z.()\-–—]+", t) for t in prefix)
    )
    return "" if ok else f"heading {' '.join(got)[:80]!r} vs source HEAD {' '.join(head_words)[:100]!r}"


# ------------------------------------------------------------- comparison
def _compare(corpus_words: list[str], source_words: list[str]) -> tuple[str, dict[str, Any] | None]:
    if corpus_words == source_words:
        return "exact", None
    sm = difflib.SequenceMatcher(None, corpus_words, source_words, autojunk=False)
    first = next((op for op in sm.get_opcodes() if op[0] != "equal"), None)
    diff = None
    if first:
        _, i1, i2, j1, j2 = first
        diff = {
            "word_index": i1,
            "corpus": " ".join(corpus_words[max(i1 - 3, 0):i2 + 3])[:200],
            "source": " ".join(source_words[max(j1 - 3, 0):j2 + 3])[:200],
        }
    if "".join(corpus_words) == "".join(source_words):
        return "whitespace_only", {"ratio": 1.0, "first_diff": diff}
    return "mismatch", {"ratio": round(sm.ratio(), 4), "first_diff": diff}


def _fail(corpus: str, source: str, ratio: float = 0.0) -> dict[str, Any]:
    return {"ratio": ratio, "first_diff": {"corpus": corpus[:200], "source": source[:200]}}


def _usc_sources(usc_path: Path, target_chapters: set[str]) -> dict[str, Any]:
    """{corpus section id: <section> element} for every real section under the
    target chapters (ids derived like the parser: the identifier after '/s')."""
    root = etree.parse(str(usc_path)).getroot()
    out: dict[str, Any] = {}
    for ch in root.iter(USLM + "chapter"):
        ident = ch.get("identifier") or ""
        if ident.rsplit("/ch", 1)[-1] not in target_chapters:
            continue
        for sec in ch.iter(USLM + "section"):
            if any(_ln(a) in ("note", "notes") for a in sec.iterancestors()):
                continue
            out["s-" + sec.get("identifier", "").rsplit("/s", 1)[-1]] = sec
    return out


def usc_release_of(usc_path: Path) -> str:
    root = etree.parse(str(usc_path)).getroot()
    el = root.find(f".//{USLM}docPublicationName")
    return el.text.split("@")[-1] if el is not None and el.text else ""


def _load_cfr_part(cache_dir: Path, cfg: dict[str, Any], date: str, part: int, fetch: bool):
    from builder.build.fetch_ecfr import cache_path, fetch_part
    cpath = cache_path(cache_dir, cfg["title"], cfg["chapter"], date, part)
    if not cpath.exists():
        if not fetch:
            raise FileNotFoundError(f"raw eCFR XML not cached: {cpath}")
        fetch_part(part, date, config={"ecfr": cfg}, cache_dir=cache_dir)
    root = etree.parse(str(cpath)).getroot()
    return {s.get("N"): s for s in root.iter("DIV8") if s.get("TYPE") == "SECTION"}


def verify(corpus: dict[str, Any], *, usc_path: Path, cache_dir: Path,
           config: dict[str, Any] | None = None, fetch_missing: bool = True) -> dict[str, Any]:
    cfg = config or load_config()
    mismatches: list[dict[str, Any]] = []
    whitespace_only: list[dict[str, Any]] = []
    by_kind = {"usc": {"checked": 0, "exact": 0}, "ecfr": {"checked": 0, "exact": 0}}
    omitted_images: list[str] = []
    dash_stats: dict[str, int] = {"heading_dash": 0}

    def record(kind: str, pid: str, status: str, info) -> None:
        by_kind[kind]["checked"] += 1
        if status == "exact":
            by_kind[kind]["exact"] += 1
        elif status == "whitespace_only":
            whitespace_only.append({"id": pid, **info})
        else:
            mismatches.append({"id": pid, **info})

    src_rp = usc_release_of(usc_path)
    if src_rp != corpus["source"]["usc_release_point"]:
        raise SystemExit(
            f"{usc_path} is release point {src_rp!r} but the corpus was built from "
            f"{corpus['source']['usc_release_point']!r}"
        )

    # ---- statutes
    secs = _usc_sources(usc_path, set(cfg["uslm"]["target_chapters"]))
    corpus_ids = {s["id"] for a in corpus["acts"] for s in a["sections"]}
    for sid in sorted(set(secs) - corpus_ids):
        record("usc", sid, "mismatch", _fail("(section missing from corpus)", sid))
    for act in corpus["acts"]:
        for s in act["sections"]:
            src = secs.get(s["id"])
            if src is None:
                record("usc", s["id"], "mismatch", _fail(s["id"], "(not in source XML)"))
                continue
            status, info = _compare(flatten(s["content"], "usc"), usc_words(src))
            if status != "mismatch" and footnote_bodies(s["content"]) != usc_footnotes(src):
                status, info = "mismatch", _fail(
                    f"footnotes {footnote_bodies(s['content'])}", f"footnotes {usc_footnotes(src)}")
            if status != "mismatch" and _canon(s["heading"]) != usc_heading_words(src):
                status, info = "mismatch", _fail(
                    f"heading {s['heading']!r}", f"heading {' '.join(usc_heading_words(src))!r}")
            record("usc", s["id"], status, info)

    # ---- regulations
    ecfr_date = corpus["source"]["ecfr_date"]
    for reg in corpus["regulations"]:
        part = int(reg["part"]) if "part" in reg else int(reg["id"].rsplit("-p", 1)[-1])
        src_secs = _load_cfr_part(cache_dir, cfg["ecfr"], ecfr_date, part, fetch_missing)
        by_n = {r["cite"].split("§ ", 1)[1]: r for r in reg["rules"]}
        for n in sorted(set(src_secs) - set(by_n)):
            record("ecfr", f"{reg['id']}:{n}", "mismatch", _fail("(rule missing from corpus)", n))
        for n, r in by_n.items():
            src = src_secs.get(n)
            if src is None:
                record("ecfr", r["id"], "mismatch", _fail(n, "(not in source XML)"))
                continue
            status, info = _compare(flatten(r["content"], "cfr"), cfr_words(src, dash_stats))
            if status != "mismatch":
                problem = heading_problem(r["heading"], cfr_head_words(src))
                if problem:
                    status, info = "mismatch", _fail(problem, "")
            record("ecfr", r["id"], status, info)
            if any(n_.get("role") == "omitted" for n_ in _walk(r["content"])):
                omitted_images.append(r["id"])

    checked = by_kind["usc"]["checked"] + by_kind["ecfr"]["checked"]
    exact = by_kind["usc"]["exact"] + by_kind["ecfr"]["exact"]
    return {
        "usc_release_point": corpus["source"]["usc_release_point"],
        "ecfr_date": ecfr_date,
        "corpus_generated_at": corpus.get("generated_at", ""),
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "checked": checked,
        "exact": exact,
        "whitespace_only": len(whitespace_only),
        "heading_dash": dash_stats["heading_dash"],
        "by_kind": by_kind,
        "mismatches": mismatches,
        "whitespace_only_detail": whitespace_only,
        "image_placeholders_in": omitted_images,
        "method": METHOD,
    }


def main() -> None:
    ap = argparse.ArgumentParser(description="Verify corpus.json against the source XML")
    ap.add_argument("--corpus", type=Path, default=BUILDER_DIR / "corpus.json")
    ap.add_argument("--config", type=Path, default=DEFAULT_CONFIG_PATH)
    ap.add_argument("--usc", type=Path, default=None, help="USLM XML (default: uslm.xml_path)")
    ap.add_argument("--cache", type=Path, default=DEFAULT_CACHE, help="raw eCFR XML cache dir")
    ap.add_argument("--report", type=Path, default=BUILDER_DIR / "verify_report.json")
    ap.add_argument("--no-fetch", action="store_true", help="fail instead of fetching uncached eCFR parts")
    args = ap.parse_args()
    cfg = load_config(args.config)
    corpus = json.loads(args.corpus.read_text(encoding="utf-8"))
    usc = args.usc or ROOT / cfg["uslm"]["xml_path"]
    report = verify(corpus, usc_path=usc, cache_dir=args.cache, config=cfg,
                    fetch_missing=not args.no_fetch)
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    bad = report["mismatches"]
    print(f"verified {report['checked']} provisions: {report['exact']} exact, "
          f"{report['whitespace_only']} whitespace-only, {len(bad)} mismatched "
          f"(USC {report['usc_release_point']}, eCFR {report['ecfr_date']})")
    for m in bad[:25]:
        print("  MISMATCH", m["id"], m.get("ratio"), json.dumps(m.get("first_diff"), ensure_ascii=False)[:300])
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
