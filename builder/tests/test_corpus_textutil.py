from builder.build.textutil import FOOTNOTE_MARK_RE, smart_title, superscript


def test_superscript_digits():
    assert superscript("1") == "¹"
    assert superscript("77") == "⁷⁷"
    assert superscript("10") == "¹⁰"
    assert superscript("a2b") == "²"  # non-digits dropped


def test_footnote_mark_regex_matches_exactly_the_marker_characters():
    for d in "0123456789":
        assert FOOTNOTE_MARK_RE.fullmatch(superscript(d)), d
    assert FOOTNOTE_MARK_RE.search("plain 123 text") is None
    assert FOOTNOTE_MARK_RE.sub("", "word²³ more") == "word more"


def test_smart_title_basics():
    assert smart_title("GENERAL RULES AND REGULATIONS, SECURITIES ACT OF 1933") == \
        "General Rules and Regulations, Securities Act of 1933"
    assert smart_title("general requirements") == "General Requirements"
    # mixed case is left alone
    assert smart_title("Regulation D—Rules Governing the Limited Offer") == \
        "Regulation D—Rules Governing the Limited Offer"


def test_smart_title_keeps_acronyms_and_single_letter_segments():
    s = smart_title("REGULATIONS M, SHO, ATS, AC, NMS, SE, AND SBSR, AND CUSTOMER MARGIN",
                    acronyms=["SHO", "ATS", "AC", "NMS", "SE", "SBSR"])
    assert s == "Regulations M, SHO, ATS, AC, NMS, SE, and SBSR, and Customer Margin"
    assert smart_title("REGULATION S–K") == "Regulation S–K"
    assert smart_title("SUBCHAPTER I— PUBLIC COMPANY ACCOUNTING OVERSIGHT BOARD").startswith("Subchapter I—")
