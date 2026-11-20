"""Smoke test against the real usc15.xml — checked in but slow-ish."""
import re
from pathlib import Path
import pytest
from builder.build.parse_uslm import parse_title

REAL = Path(__file__).parent.parent.parent / "uscode_xml" / "usc15.xml"


@pytest.fixture(scope="module")
def real_parsed():
    return parse_title(REAL)


def _walk(blocks):
    for b in blocks:
        yield b
        yield from _walk(b.get("children", []) or [])


@pytest.mark.skipif(not REAL.exists(), reason="real usc15.xml not present")
def test_real_parse_finds_five_target_chapters(real_parsed):
    chapters = {a["usc_chapter"] for a in real_parsed["acts"]}
    assert chapters == {"15/2A", "15/2B", "15/2B–1", "15/2D", "15/98"}


@pytest.mark.skipif(not REAL.exists(), reason="real usc15.xml not present")
def test_real_parse_splits_acts_by_subchapter(real_parsed):
    """Acts are no longer one-per-chapter: the Trust Indenture Act, the
    Corporation of Foreign Bondholders Act and the Investment Advisers Act are
    subchapters of chapters 2A and 2D and print under their own names."""
    acts = {a["id"]: a for a in real_parsed["acts"]}
    # existing act ids are permanent; new ids are additive
    assert {"act-ch2A", "act-ch2B", "act-ch2B–1", "act-ch2D"} <= set(acts)
    assert {"act-ch2A-schII", "act-ch2A-schIII", "act-ch2D-schII", "act-ch98"} <= set(acts)
    by_id = {s["id"]: (a["id"], s) for a in real_parsed["acts"] for s in a["sections"]}
    assert by_id["s-77aaa"][0] == "act-ch2A-schIII"
    assert by_id["s-77aaa"][1]["original"]["cite"] == "Trust Indenture Act of 1939 § 301"
    assert by_id["s-77bb"][1]["original"]["cite"] == "Corporation of Foreign Bondholders Act, 1933 § 201"
    assert by_id["s-80b–6"][0] == "act-ch2D-schII"
    assert by_id["s-80b–6"][1]["original"]["cite"] == "Investment Advisers Act of 1940 § 206"
    assert by_id["s-80a–1"][0] == "act-ch2D"
    # sections that used to have no (or a wrong) original number
    assert by_id["s-78u–4"][1]["original"] == {
        "num": "21D", "cite": "Securities Exchange Act of 1934 § 21D"}
    assert by_id["s-77aa"][1]["original"]["cite"] == "Securities Act of 1933 Schedules A, B"
    assert by_id["s-78aaa"][1]["original"]["cite"] == "Securities Investor Protection Act of 1970 § 1"
    assert by_id["s-78ggg"][1]["original"]["num"] == "11"
    assert by_id["s-7241"][1]["original"]["cite"] == "Sarbanes-Oxley Act of 2002 § 302"
    # a free-standing Dodd-Frank section must not borrow the Exchange Act's numbering
    assert by_id["s-78d–6"][1]["original"] is None
    # act-level metadata
    assert acts["act-ch2A"]["original_name_short"] == "Securities Act"
    assert acts["act-ch2A"]["usc_range"] == "15 U.S.C. §§ 77a–77aa"
    assert [a["order"] for a in real_parsed["acts"]] == sorted(a["order"] for a in real_parsed["acts"])
    sox = acts["act-ch98"]
    assert [d["label"] for d in sox["divisions"]][:2] == [
        "General provisions", "Subchapter I—Public Company Accounting Oversight Board"]
    assert sum(len(d["sections"]) for d in sox["divisions"]) == len(sox["sections"])


@pytest.mark.skipif(not REAL.exists(), reason="real usc15.xml not present")
def test_real_parse_finds_securities_act_77e(real_parsed):
    act = next(a for a in real_parsed["acts"] if a["usc_chapter"] == "15/2A")
    sec = next(s for s in act["sections"] if s["id"] == "s-77e")
    assert sec["heading"].startswith("Prohibitions relating to interstate commerce")
    assert len(sec["content"]) >= 1
    assert "Stat." in sec["source_credit"]


@pytest.mark.skipif(not REAL.exists(), reason="real usc15.xml not present")
def test_real_parse_emits_table_block_for_target_fee_collection_amount(real_parsed):
    """§ 77f(b)(6)(A) contains an XHTML <table>; parser must emit a table block,
    not silently flatten the table rows into one paragraph."""
    act = next(a for a in real_parsed["acts"] if a["usc_chapter"] == "15/2A")
    sec = next(s for s in act["sections"] if s["id"] == "s-77f")
    tables = [b for b in _walk(sec["content"]) if b.get("type") == "table"]
    assert tables, "expected at least one table block in § 77f"
    html = tables[0]["html"]
    assert html.startswith("<table>") and html.endswith("</table>")
    assert "<thead>" in html and "<tbody>" in html
    assert "Fiscal year:" in html
    assert "Target fee collection amount" in html
    assert "$377,000,000" in html


@pytest.mark.skipif(not REAL.exists(), reason="real usc15.xml not present")
def test_real_parse_keeps_footnotes_as_data_not_as_words(real_parsed):
    """USLM splices footnote markers and <note> bodies ("So in original.",
    "See References in Text…") into headings and the running text. They must
    never leak into either as words: the marker is a run of superscript
    digits glued to its word, the body is a role="footnote" node."""
    marker = re.compile("[⁰¹²³⁴-⁹]")
    leak, footnotes = [], 0
    for act in real_parsed["acts"]:
        for sec in act["sections"]:
            assert not re.search(r"So in original|See References", sec["heading"]), sec["id"]
            for block in _walk(sec.get("content", [])):
                for key in ("heading",):
                    h = block.get(key) or ""
                    if re.search(r"So in original|See References", h) or marker.search(h):
                        leak.append((sec["id"], "heading", h[:80]))
                t = block.get("text") or ""
                if block.get("role") == "footnote":
                    footnotes += 1
                    assert marker.match(t) and t[len(marker.match(t).group(0))] == " ", t[:40]
                    continue
                if "So in original" in t or "See References in Text" in t:
                    leak.append((sec["id"], "note-body", t[:80]))
                # a lone digit between a close-paren and "of title/this" is a
                # stray footnote marker (statutory text never reads that way)
                if re.search(r"\)\s+\d+\s+of (?:this title|title \d)", t):
                    leak.append((sec["id"], "stray-marker", t[:80]))
                if re.search(r"\s[⁰¹²³⁴-⁹]", t):
                    leak.append((sec["id"], "marker-not-glued", t[:80]))
    assert not leak, f"footnote apparatus leaked into text: {leak[:5]}"
    assert footnotes > 100  # they are kept, not dropped

    # the audit's § 78c(80) case
    act = next(a for a in real_parsed["acts"] if a["usc_chapter"] == "15/2B")
    sec = next(s for s in act["sections"] if s["id"] == "s-78c")
    text = " ".join((b.get("text") or "") for b in _walk(sec["content"]))
    # the marker hugs "103(c)(2)" instead of reading "103(c)(2) 1 of title 26"
    assert "industrial development bond (as defined in section 103(c)(2)¹ of title 26)" in text
    para80 = [b for b in _walk(sec["content"]) if b.get("num") == "80" and b["type"] == "paragraph"]
    assert [p["heading"] for p in para80][:2] == ["Emerging growth company.—", "Funding portal.—"]


@pytest.mark.skipif(not REAL.exists(), reason="real usc15.xml not present")
def test_real_parse_keeps_provisos_levels_subitems_and_mixed_content(real_parsed):
    """These shapes were dropped silently before the verification step found
    them: § 77jjj/80a–2/80a–29 provisos, § 78f(e)(3)(E) levels, § 78o(b)(13)
    subitems, § 77aa(32) and § 78u(h)(4)(C) text before a nested <p>."""
    secs = {s["id"]: s for a in real_parsed["acts"] for s in a["sections"]}
    def text_of(sid):
        return " ".join((b.get("text") or "") for b in _walk(secs[sid]["content"]))
    assert "Provided, That the indenture to be qualified shall automatically" in text_of("s-77jjj")
    assert "Provided, That if in the judgment of the Commission any item" in text_of("s-80a–29")
    assert "a Commission determination under subparagraph (A)" in text_of("s-78f")
    assert "electing executive officers" in text_of("s-78o")
    assert "a copy of the underlying agreements or indentures" in text_of("s-77aa")
    assert "Upon expiration of the period of delay of notification" in text_of("s-78u")
